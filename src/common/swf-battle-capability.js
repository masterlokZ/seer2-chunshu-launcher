'use strict';

const ultimateCapability = require('./modules/ultimate-capability');

function isBattleActionLabel(label) {
  return /^(?:attack\d*|sa\d*|cp\d*|hited\d*|appear\d*|dead\d*|win\d*|transform\d*|add\d+)$/.test(label) ||
    ultimateCapability.isDedicatedUltimateAction(label);
}

function isDecisiveActionLabel(label) {
  return /^(?:attack\d*|sa\d*|cp\d*|hited\d*)$/.test(label) ||
    ultimateCapability.isDedicatedUltimateAction(label);
}

// Inspect the exported `pet` timeline by action branch.  A number of recent
// U-client-first resources ship a large legacy SWF whose global structure looks
// animated, while attack/sa/cp only select a one-frame bitmap pose.  Global
// sprite counts therefore cannot decide whether that SWF is a battle model.

function readCString(data, start, end) {
  var cursor = start;
  while (cursor < end && data[cursor] !== 0) cursor++;
  return { value:data.slice(start, cursor).toString('utf8'), end:Math.min(end, cursor + 1) };
}

function placedCharacter(tag, data) {
  var body = tag.body;
  if (tag.code === 4 && body + 4 <= tag.end) {
    return { depth:data.readUInt16LE(body + 2), characterId:data.readUInt16LE(body) };
  }
  if (tag.code === 26 && body + 3 <= tag.end) {
    var flags2 = data[body];
    var cursor2 = body + 3;
    return {
      depth:data.readUInt16LE(body + 1),
      characterId:(flags2 & 0x02) && cursor2 + 2 <= tag.end ? data.readUInt16LE(cursor2) : 0,
    };
  }
  if (tag.code === 70 && body + 4 <= tag.end) {
    var flags = data[body];
    var extra = data[body + 1];
    var cursor = body + 4;
    if ((extra & 0x08) || ((extra & 0x10) && (flags & 0x02))) {
      cursor = readCString(data, cursor, tag.end).end;
    }
    return {
      depth:data.readUInt16LE(body + 2),
      characterId:(flags & 0x02) && cursor + 2 <= tag.end ? data.readUInt16LE(cursor) : 0,
    };
  }
  return null;
}

function timelineFromRange(data, start, end, declaredFrames, readTagHeader) {
  var labels = [];
  var frames = [];
  var display = new Map();
  var position = start;
  var frameNumber = 1;
  while (position < end && frames.length < 20000) {
    var tag = readTagHeader(data, position, end);
    if (!tag) break;
    if (tag.code === 43) {
      var label = readCString(data, tag.body, tag.end).value.trim().toLowerCase();
      if (label) labels.push({ label:label, frame:frameNumber });
    } else if (tag.code === 4 || tag.code === 26 || tag.code === 70) {
      var placed = placedCharacter(tag, data);
      if (placed) {
        var previous = display.get(placed.depth);
        var characterId = placed.characterId || (previous && previous.characterId) || 0;
        // Include the full placement payload.  Move-only transforms and morph
        // ratios then count as animation even when the character id is stable.
        display.set(placed.depth, {
          characterId:characterId,
          state:tag.code + ':' + data.slice(tag.body, tag.end).toString('base64'),
        });
      }
    } else if (tag.code === 5 && tag.body + 4 <= tag.end) {
      display.delete(data.readUInt16LE(tag.body + 2));
    } else if (tag.code === 28 && tag.body + 2 <= tag.end) {
      display.delete(data.readUInt16LE(tag.body));
    } else if (tag.code === 1) {
      var ordered = Array.from(display.entries()).sort(function(a, b) { return a[0] - b[0]; });
      frames.push({
        number:frameNumber,
        signature:ordered.map(function(pair) { return pair[0] + '=' + pair[1].state; }).join('|'),
        characterIds:ordered.map(function(pair) { return pair[1].characterId; }).filter(Boolean),
      });
      frameNumber++;
    }
    position = tag.end;
    if (tag.code === 0) break;
  }
  while (frames.length < Number(declaredFrames || 0)) {
    var last = frames[frames.length - 1] || { signature:'', characterIds:[] };
    frames.push({ number:frames.length + 1, signature:last.signature, characterIds:last.characterIds.slice() });
  }
  return { labels:labels, frames:frames, declaredFrames:Number(declaredFrames || frames.length) };
}

function inspectPetActionBranches(data, rootStart, readTagHeader) {
  var sprites = new Map();
  var symbols = new Map();
  var position = rootStart;
  while (position < data.length) {
    var tag = readTagHeader(data, position, data.length);
    if (!tag) break;
    if (tag.code === 39 && tag.body + 4 <= tag.end) {
      var spriteId = data.readUInt16LE(tag.body);
      var frameCount = data.readUInt16LE(tag.body + 2);
      sprites.set(spriteId, timelineFromRange(data, tag.body + 4, tag.end, frameCount, readTagHeader));
    } else if ((tag.code === 76 || tag.code === 56) && tag.body + 2 <= tag.end) {
      var count = data.readUInt16LE(tag.body);
      var cursor = tag.body + 2;
      for (var index = 0; index < count && cursor + 2 <= tag.end; index++) {
        var characterId = data.readUInt16LE(cursor); cursor += 2;
        var name = readCString(data, cursor, tag.end); cursor = name.end;
        if (name.value) symbols.set(name.value.toLowerCase(), characterId);
      }
    }
    position = tag.end;
    if (tag.code === 0) break;
  }

  var petId = symbols.get('pet') || 0;
  var pet = sprites.get(petId);
  if (!pet) return { found:false, petId:petId, actions:[], dynamicCoreActions:[], staticCoreActions:[] };

  var memo = new Map();
  function spriteDynamic(id, stack) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return false;
    var timeline = sprites.get(id);
    if (!timeline || !timeline.frames.length) return false;
    var next = new Set(stack); next.add(id);
    var firstSignature = timeline.frames[0].signature;
    var ownChange = timeline.frames.some(function(frame) { return frame.signature !== firstSignature; });
    var childChange = timeline.frames.some(function(frame) {
      return frame.characterIds.some(function(childId) { return spriteDynamic(childId, next); });
    });
    var result = ownChange || childChange;
    memo.set(id, result);
    return result;
  }

  var labels = pet.labels.filter(function(item) { return isBattleActionLabel(item.label); })
    .sort(function(a, b) { return a.frame - b.frame; });
  var actions = labels.map(function(item, actionIndex) {
    var endFrame = actionIndex + 1 < labels.length ? labels[actionIndex + 1].frame - 1 : pet.frames.length;
    var branchFrames = pet.frames.filter(function(frame) {
      return frame.number >= item.frame && frame.number <= endFrame;
    });
    var first = branchFrames[0] ? branchFrames[0].signature : '';
    var rootChanges = branchFrames.some(function(frame) { return frame.signature !== first; });
    var childChanges = branchFrames.some(function(frame) {
      return frame.characterIds.some(function(childId) { return spriteDynamic(childId, new Set([petId])); });
    });
    var directIds = Array.from(new Set([].concat.apply([], branchFrames.map(function(frame) {
      return frame.characterIds;
    }))));
    var maxDirectTimelineFrames = directIds.reduce(function(maximum, childId) {
      var child = sprites.get(childId);
      return Math.max(maximum, child ? Number(child.declaredFrames || child.frames.length) : 0);
    }, 0);
    // A three-frame selector (pose -> hit marker -> pose) is the common U-client
    // compatibility shell.  It technically changes display objects, but does
    // not provide a watchable attack animation.  Four or more visual timeline
    // frames, or an animated descendant, are required for a dynamic branch.
    var descendantChanges = directIds.some(function(childId) {
      var child = sprites.get(childId);
      if (!child) return false;
      return child.frames.some(function(frame) {
        return frame.characterIds.some(function(grandChildId) {
          return spriteDynamic(grandChildId, new Set([petId, childId]));
        });
      });
    });
    var dynamic = rootChanges || descendantChanges || (childChanges && maxDirectTimelineFrames >= 4);
    return {
      label:item.label,
      startFrame:item.frame,
      endFrame:endFrame,
      dynamic:dynamic,
      rootChanges:rootChanges,
      childChanges:childChanges,
      maxDirectTimelineFrames:maxDirectTimelineFrames,
      characterIds:directIds.slice(0, 40),
    };
  });
  var decisive = actions.filter(function(action) {
    return isDecisiveActionLabel(action.label);
  });
  return {
    found:true,
    petId:petId,
    actions:actions,
    dynamicCoreActions:decisive.filter(function(action) { return action.dynamic; }).map(function(action) { return action.label; }),
    staticCoreActions:decisive.filter(function(action) { return !action.dynamic; }).map(function(action) { return action.label; }),
  };
}

module.exports = {
  inspectPetActionBranches:inspectPetActionBranches,
  isBattleActionLabel:isBattleActionLabel,
  isDecisiveActionLabel:isDecisiveActionLabel,
};
