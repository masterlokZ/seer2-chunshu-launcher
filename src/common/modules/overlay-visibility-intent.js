'use strict';

// BrowserWindow visibility and the user's requested visibility are different
// while a renderer is still loading. Keep the request explicit so a late
// ready signal cannot undo a dismissal made in the meantime.
module.exports = function createOverlayVisibilityIntent() {
  var requested = false;

  return {
    requestOpen:function() { requested = true; },
    requestClose:function() { requested = false; },
    shouldShow:function() { return requested; },
  };
};
