'use strict';

function verifiedLegacy(evidence) {
  evidence = evidence || {};
  return evidence.available !== false && evidence.staticPoseWrapper !== true &&
    (evidence.playable === true || evidence.legacyPlayable === true ||
     evidence.playbackVerified === true);
}

function completeUClient(evidence) {
  evidence = evidence || {};
  return evidence.available === true && evidence.complete === true &&
    evidence.conversionReady !== false;
}

function legacyNeedsFallback(evidence) {
  evidence = evidence || {};
  return evidence.available === false || evidence.staticPoseWrapper === true ||
    evidence.playable === false || evidence.legacyPlayable === false;
}

function selectBattleResource(evidence) {
  evidence = evidence || {};
  if (verifiedLegacy(evidence.legacy)) {
    return {
      selectedBattleVariant:'legacy-swf',
      selectionReason:'capability-verified-playable-legacy-primary',
      requiresUClientConversion:false,
    };
  }
  if (completeUClient(evidence.uclient) && legacyNeedsFallback(evidence.legacy)) {
    return {
      selectedBattleVariant:'uclient-self-contained',
      selectionReason:evidence.legacy && evidence.legacy.staticPoseWrapper === true
        ? 'identity-matched-u-client-primary-over-static-legacy-shell'
        : 'u-client-primary-without-playable-legacy',
      requiresUClientConversion:true,
    };
  }
  if (evidence.legacy && evidence.legacy.available !== false &&
      evidence.legacy.staticPoseWrapper !== true) {
    return {
      selectedBattleVariant:'legacy-swf-pending',
      selectionReason:'legacy-swf-capability-probe-required',
      requiresUClientConversion:false,
    };
  }
  return {
    selectedBattleVariant:'',
    selectionReason:evidence.legacy && evidence.legacy.staticPoseWrapper === true
      ? 'legacy-static-shell-u-client-unavailable' : 'no-playable-battle-resource',
    requiresUClientConversion:!verifiedLegacy(evidence.legacy),
  };
}

module.exports = {
  verifiedLegacy:verifiedLegacy,
  completeUClient:completeUClient,
  legacyNeedsFallback:legacyNeedsFallback,
  selectBattleResource:selectBattleResource,
};
