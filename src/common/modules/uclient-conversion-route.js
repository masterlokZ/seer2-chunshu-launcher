'use strict';

const SPINE_ACTIONS = Object.freeze(['appear','attack','cp','sa','hidemove']);

function ownerId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function classifyModelAssetPath(value) {
  const assetPath = String(value || '');
  let match = assetPath.match(/^Assets\/Pets\/(\d+)\.prefab$/i);
  if (match && ownerId(match[1])) {
    return { family:'ftr',ownerId:Number(match[1]),baseConverter:'uclient-ftr' };
  }
  match = assetPath.match(/^Assets\/SkillTimeline\/Spines\/(\d+)\/(\d+)\.prefab$/i);
  if (match && match[1] === match[2] && ownerId(match[1])) {
    return { family:'spine',ownerId:Number(match[1]),baseConverter:'uclient-spine' };
  }
  return null;
}

function actionName(item, kind) {
  const direct = String(item && item.action || '').trim().toLowerCase();
  if (direct) return direct;
  const assetPath = String(item && item.assetPath || '');
  const suffix = kind === 'timeline' ? '\\.playable' : '\\.prefab';
  const match = assetPath.match(new RegExp('/([^/]+)' + suffix + '$','i'));
  return String(match && match[1] || '').toLowerCase();
}

function exactSpineActions(values, kind) {
  if (!Array.isArray(values)) return false;
  const actions = values.map(function(item) { return actionName(item,kind); }).filter(Boolean);
  return actions.length === SPINE_ACTIONS.length && new Set(actions).size === SPINE_ACTIONS.length &&
    SPINE_ACTIONS.every(function(action) { return actions.includes(action); });
}

function ownedVideoCount(values, expectedOwnerId, prefix) {
  if (!Array.isArray(values)) return 0;
  const anchor = new RegExp('^' + prefix + '/' + expectedOwnerId + '/[^/]+\\.mp4$','i');
  return values.filter(function(item) {
    const declaredOwner = ownerId(item && item.ownerId);
    return (!declaredOwner || declaredOwner === expectedOwnerId) &&
      anchor.test(String(item && item.assetPath || ''));
  }).length;
}

function selectConversionRoute(credential) {
  credential = credential || {};
  const expectedOwnerId = ownerId(credential.assetId);
  const model = credential.model || {};
  const classification = classifyModelAssetPath(model.assetPath);
  if (!expectedOwnerId || !classification || classification.ownerId !== expectedOwnerId) {
    throw new Error('U-client model asset path does not identify the requested owner');
  }
  const declaredFamily = String(credential.family || '').toLowerCase();
  if (declaredFamily && declaredFamily !== classification.family) {
    throw new Error('U-client model family conflicts with its asset path');
  }
  const families = credential.resourceFamilies || {};
  if (classification.family === 'ftr') {
    const eventVideos = ownedVideoCount(families.standardEventVideos,expectedOwnerId,
      'Assets/Game/Videos');
    return Object.freeze({
      version:1,family:'ftr',ownerId:expectedOwnerId,baseConverter:'uclient-ftr',
      supplementalConverter:eventVideos > 0 ? 'ftr-standard-event-video' : 'none',
      resourcePlanVersion:2,routeKey:eventVideos > 0 ? 'ftr+event-video' : 'ftr',
      reason:'asset-path-family-with-owned-supplemental-resources',
    });
  }
  const skill = families.skillTimeline || {};
  const skillTimelineComplete = exactSpineActions(skill.timelines,'timeline') &&
    exactSpineActions(skill.effects,'effect') &&
    ownedVideoCount(skill.videos,expectedOwnerId,'Assets/SkillTimeline/Videos') > 0;
  return Object.freeze({
    version:1,family:'spine',ownerId:expectedOwnerId,baseConverter:'uclient-spine',
    supplementalConverter:skillTimelineComplete ? 'spine-skill-timeline' : 'none',
    resourcePlanVersion:3,
    routeKey:skillTimelineComplete ? 'spine+skill-timeline' : 'spine',
    reason:'asset-path-family-with-owned-supplemental-resources',
  });
}

module.exports = {
  SPINE_ACTIONS:SPINE_ACTIONS,
  classifyModelAssetPath:classifyModelAssetPath,
  selectConversionRoute:selectConversionRoute,
};
