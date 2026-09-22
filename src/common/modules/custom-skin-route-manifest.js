'use strict';

var fs = require('fs');
var path = require('path');
var deriveCustomSkinIdentity = require('./custom-skin-identity').deriveCustomSkinIdentity;

function idOf(entry) {
  return parseInt(entry.skinId || entry.targetPetId, 10) || 0;
}

function escapeAttr(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function routeSource(route) {
  return String(route && (route.source || route) || '').trim()
    .replace(/\\/g, '/').toLowerCase();
}

function isSameFile(left, right) {
  var leftSource = String(left || '').trim();
  var rightSource = String(right || '').trim();
  if (!leftSource || !rightSource || /^https?:\/\//i.test(leftSource) || /^https?:\/\//i.test(rightSource)) {
    return false;
  }
  try {
    var leftPath = path.resolve(leftSource);
    var rightPath = path.resolve(rightSource);
    if (leftPath.toLowerCase() === rightPath.toLowerCase()) return true;
    try {
      if (fs.realpathSync(leftPath).toLowerCase() === fs.realpathSync(rightPath).toLowerCase()) return true;
    } catch(_) {}
    var leftStat = fs.statSync(leftPath);
    var rightStat = fs.statSync(rightPath);
    return leftStat.isFile() && rightStat.isFile() &&
      leftStat.dev === rightStat.dev && leftStat.ino !== 0 && leftStat.ino === rightStat.ino;
  } catch(_) {
    return false;
  }
}

function isFightDerivedIconRoute(entry, icon, fight, sameFile) {
  if (!fight) return false;
  if (!icon) return true;
  if (String(icon.presentation || '').toLowerCase() === 'frozen-avatar') return true;
  if (sameFile === true) return true;
  var iconSource = routeSource(icon);
  var fightSource = routeSource(fight);
  if (iconSource && fightSource && iconSource === fightSource) return true;
  var resourceInfo = entry && entry.resourceInfo || {};
  var iconInfo = resourceInfo.icon || {};
  return String(iconInfo.derivedFrom || '').toLowerCase() === 'fight' ||
    (String(iconInfo.mode || '').toLowerCase() === 'derived' &&
      routeSource(iconInfo) === routeSource(resourceInfo.fight));
}

function buildCustomSkinManifestXml(snapshot) {
  var rows = snapshot.entries.filter(function(entry) {
    return entry.officialIdOverride !== true;
  }).sort(function(a, b) { return idOf(a) - idOf(b); }).map(function(entry) {
    return '  <skin id="' + idOf(entry) + '" />';
  });
  return Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n' +
    '<launcherSkins revision="' + snapshot.revision + '">\n' +
    rows.join('\n') + (rows.length ? '\n' : '') + '</launcherSkins>\n', 'utf8');
}

function buildCustomSkinRoutesXml(snapshot) {
  var routes = snapshot.routes;
  var previewRoutes = snapshot.previewRoutes || routes;
  var rows = snapshot.entries.slice().sort(function(a, b) {
    return idOf(a) - idOf(b);
  }).map(function(entry) {
    var id = idOf(entry);
    var officialIdOverride = entry.officialIdOverride === true;
    var demo = routes.get('demo:' + id);
    var icon = routes.get('icon:' + id);
    var presentation = demo && demo.presentation
      ? demo.presentation : String(entry.presentationMode || 'legacy');
    var fight = routes.get('fight:' + id);
    var iconPresentation = !officialIdOverride && isFightDerivedIconRoute(entry, icon, fight, false)
      ? 'frozen-avatar' : 'native-icon';
    var identity = deriveCustomSkinIdentity(entry);
    var panelPreviewKind = '';
    var panelPreviewRoute = null;
    ['icon', 'fight', 'normal'].some(function(type) {
      var route = previewRoutes.get(type + ':' + id);
      if (!route) return false;
      panelPreviewKind = type;
      panelPreviewRoute = route;
      return true;
    });
    var panelPreviewPresentation = panelPreviewRoute && panelPreviewRoute.presentation
      ? String(panelPreviewRoute.presentation)
      : (panelPreviewKind === 'icon' ? 'native-icon' : 'frozen-avatar');
    function has(type) {
      if (officialIdOverride && type === 'icon') return 0;
      return routes.has(type + ':' + id) ? 1 : 0;
    }
    return '  <route id="' + id + '" sourceId="' + (parseInt(entry.sourceId, 10) || 0) +
      '" name="' + escapeAttr(identity.name) +
      '" identityId="' + identity.id +
      '" basePetId="' + identity.basePetId +
      '" officialSkinId="' + identity.officialSkinId +
      '" sourceKind="' + escapeAttr(identity.sourceKind) +
      '" officialIdOverride="' + (officialIdOverride ? 1 : 0) +
      '" fight="' + has('fight') + '" normal="' + has('normal') +
      '" icon="' + has('icon') + '" demo="' + has('demo') +
      '" dictionary="' + has('dictionary') + '" presentation="' +
      escapeAttr(presentation) + '" iconPresentation="' +
      escapeAttr(iconPresentation) + '" panelPreviewKind="' +
      escapeAttr(panelPreviewKind) + '" panelPreviewPresentation="' +
      escapeAttr(panelPreviewPresentation) + '" />';
  });
  return Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n' +
    '<launcherSkinRoutes revision="' + snapshot.revision + '">\n' +
    rows.join('\n') + (rows.length ? '\n' : '') + '</launcherSkinRoutes>\n', 'utf8');
}

// PetSkinPanel consumes a dedicated, read-only registry.  Keep it separate
// from the generic launcher manifest so the in-game panel can enumerate local
// skins even when the runtime pet id overlaps an official entry.
function buildPetSkinPanelRoutesXml(snapshot) {
  var rows = snapshot.entries.slice().sort(function(a, b) {
    return idOf(a) - idOf(b);
  }).map(function(entry) {
    var id = idOf(entry);
    var demo = snapshot.routes.get('demo:' + id);
    var icon = snapshot.previewRoutes.get('icon:' + id);
    var fight = snapshot.previewRoutes.get('fight:' + id);
    var sameIconFile = isSameFile(icon && icon.source, fight && fight.source);
    var genuineIcon = !!icon && !isFightDerivedIconRoute(entry, icon, fight, sameIconFile);
    return '  <skin id="' + id + '" sourceId="' + (parseInt(entry.sourceId, 10) || 0) +
      '" name="' + escapeAttr(entry.name || '') + '" demo="' +
      (demo ? 1 : 0) + '" avatarKind="' + (genuineIcon ? 'icon' : 'fight') + '" />';
  });
  return Buffer.from('<?xml version="1.0" encoding="utf-8"?>\n' +
    '<petSkinPanelRoutes revision="' + snapshot.revision + '">\n' +
    rows.join('\n') + (rows.length ? '\n' : '') + '</petSkinPanelRoutes>\n', 'utf8');
}

module.exports = {
  buildCustomSkinManifestXml,
  buildCustomSkinRoutesXml,
  buildPetSkinPanelRoutesXml,
  isSameFile,
  isFightDerivedIconRoute,
};
