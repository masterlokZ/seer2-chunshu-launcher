package
{
   import flash.display.Bitmap;
   import flash.display.BlendMode;
   import flash.display.FrameLabel;
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.display.DisplayObjectContainer;
   import flash.display.Shape;
   import flash.events.Event;
   import flash.external.ExternalInterface;
   import flash.geom.Point;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;

   [SWF(width="1200", height="660", frameRate="30", backgroundColor="#000000")]
   public class pet extends MovieClip
   {
      [Embed(source="placeholder.json", mimeType="application/octet-stream")]
      private static const ManifestBytes:Class;
      [Embed(source="placeholder.atlas", mimeType="application/octet-stream")]
      private static const AtlasText:Class;
      [Embed(source="placeholder.skel", mimeType="application/octet-stream")]
      private static const SkeletonBytes:Class;
      [Embed(source="placeholder-cinematic.swf", mimeType="application/octet-stream")]
      private static const CinematicBytes:Class;
      [Embed(source="placeholder-skill-timeline.swf", mimeType="application/octet-stream")]
      private static const SkillTimelineBytes:Class;
      include "SpineAtlasFactories.inc";

      private var _action:UClientSpineActionClip;
      private var _manifest:Object;
      private var _labels:Array = ["idle","attack","sa","cp","hited"];
      private var _selected:String = "standby";
      private var _initError:String = "";
      private var _cinematic:Object;
      private var _cinematicWindow:Object;
      private var _cinematicLoader:Loader;
      private var _cinematicClip:MovieClip;
      private var _cinematicReady:Boolean = false;
      private var _cinematicPending:Boolean = false;
      private var _cinematicActive:Boolean = false;
      private var _skillTimeline:Object;
      private var _skillTimelineLoader:Loader;
      private var _skillTimelineClip:Object;
      private var _skillTimelineReady:Boolean = false;
      private var _skillTimelinePending:Boolean = false;
      private var _skillTimelineActive:Boolean = false;
      private var _skillTimelineAction:String = "";
      private var _skillTimelineError:String = "";
      // The wrapper SWF and the selected action SWF load asynchronously.
      // Hold the Spine clock at zero until the selected child action and its
      // cinematic (when any) are both decoded.
      private var _actionStartHeld:Boolean = false;
      private var _actionStartHoldError:String = "";
      /** Optional battle-scene host for Timeline actions that declare a backdrop. */
      private var _battleBackdropHost:DisplayObjectContainer;
      private var _battleBackdrop:Shape;

      public function pet()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         addEventListener(Event.ADDED_TO_STAGE,onAddedToStage,false,0,true);
         addEventListener(Event.REMOVED_FROM_STAGE,onRemovedFromStage,false,0,true);
         addEventListener(Event.ENTER_FRAME,onActionTimelineEnterFrame,false,0,true);
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.addCallback("setUClientBattleAction",selectActionForTest);
               ExternalInterface.addCallback("setUClientBattleFrame",selectFrameForTest);
               ExternalInterface.addCallback("getUClientBattleState",getBattleState);
               ExternalInterface.addCallback("getUClientBattleVisualDigest",getBattleVisualDigest);
               ExternalInterface.addCallback("getEmbeddedCinematicState",getEmbeddedCinematicState);
               ExternalInterface.addCallback("getUClientSkillTimelineState",getSkillTimelineState);
               ExternalInterface.addCallback("disposeUClientBattleResources",disposeUClientBattleResources);
            }
         }
         catch(error:*) {}
         try
         {
            var manifestData:ByteArray = new ManifestBytes() as ByteArray;
            _manifest = JSON.parse(manifestData.readUTFBytes(manifestData.length));
            _cinematic = _manifest.cinematic;
            _skillTimeline = _manifest.skillTimeline;
            prepareEmbeddedCinematic();
            prepareSkillTimeline();
            var atlasData:ByteArray = new AtlasText() as ByteArray;
            var skeletonData:ByteArray = new SkeletonBytes() as ByteArray;
            var factories:Array = createAtlasFactories(int(_manifest.pageNames.length));
            var pages:Object = {};
            for(var index:int = 0; index < factories.length; index++)
            {
               var bitmap:Bitmap = new factories[index]() as Bitmap;
               pages[String(_manifest.pageNames[index])] = bitmap.bitmapData;
            }
            _labels = [];
            for each(var action:String in _manifest.actions)
            {
               var exposed:String = action.toLowerCase() == "await" ? "standby" : action.toLowerCase();
               if(_labels.indexOf(exposed) < 0) _labels.push(exposed);
            }
            if(_labels.indexOf("standby") >= 0 && _labels.indexOf("idle") < 0) _labels.unshift("idle");
            _action = new UClientSpineActionClip(atlasData,skeletonData,pages,_manifest);
            _action.y = 145;
            addChild(_action);
            selectAction("standby");
         }
         catch(initError:*) { _initError = String(initError); }
      }

      public function get uClientBattleReady():Boolean { return _action != null && _action.ready; }
      public function get uClientBattleClockManaged():Boolean { return _action != null && _action.uClientBattleClockManaged; }

      /**
       * Attach the Timeline's opaque backing surface to the battle scene's
       * bottom layer.  The Timeline loader itself remains on the stage so its
       * SCREEN effects/video retain their established ordering.  Previewers
       * simply omit this host and therefore never receive the battle backdrop.
       */
      public function setUClientBattleBackdropHost(value:Object,anchor:Object = null):Boolean
      {
         detachBattleBackdrop();
         _battleBackdropHost = value as DisplayObjectContainer;
         syncBattleBackdrop();
         return _battleBackdropHost != null;
      }

      /**
       * Resolve backdrop metadata from the parent manifest.  The embedded
       * Timeline state is never allowed to override a parent action record: it
       * is only an agreement check, or a compatibility fallback when the
       * parent genuinely has no backdrop fields.  Any malformed, stale or
       * contradictory data fails closed to a transparent scene.
       */
      private function currentTimelineBackgroundMetadata():Object
      {
         var record:Object = skillTimelineActionRecord(_skillTimelineAction);
         var childState:Object = timelineChildState();
         var parentHasMetadata:Boolean = record != null &&
            (record.hasOwnProperty("backgroundMode") ||
             record.hasOwnProperty("backgroundWindows") ||
             record.hasOwnProperty("backgroundGeometry"));
         var source:Object = parentHasMetadata ? record : childState;
         if(source == null) return null;

         var mode:String = normalizeBackgroundMode(source.backgroundMode);
         if(mode == "") return null;
         if(mode == "none")
         {
            if(source.hasOwnProperty("backgroundWindows") &&
               (!(source.backgroundWindows is Array) || source.backgroundWindows.length != 0))
               return null;
            if(parentHasMetadata && !backgroundChildAgrees(childState,mode,[],null)) return null;
            return { mode:"none", windows:[], bounds:null };
         }

         var sourceSize:Object = timelineSourceSize();
         if(sourceSize == null || !(source.backgroundWindows is Array) ||
            source.backgroundWindows.length == 0 || !finiteNumber(source.durationSeconds) ||
            Number(source.durationSeconds) <= 0) return null;
         var windows:Array = normalizeBackgroundWindows(source.backgroundWindows,mode);
         if(windows == null || windows.length == 0) return null;
         var duration:Number = Number(source.durationSeconds);
         for each(var backgroundWindow:Object in windows)
            if(Number(backgroundWindow.endSeconds) > duration + .001) return null;

         var bounds:Object;
         if(mode == "fullscreen")
         {
            bounds = { x:0, y:0, width:sourceSize.width, height:sourceSize.height };
         }
         else
         {
            // New manifests describe the post-build overlay geometry.  The
            // authored capture viewport must not be used here because the
            // native viewport SWF has already cropped and scaled it.
            if(source.hasOwnProperty("backgroundGeometry"))
            {
               var geometry:Object = source.backgroundGeometry;
               if(geometry == null || !geometry.hasOwnProperty("renderBounds")) return null;
               bounds = normalizeRenderBounds(geometry.renderBounds,sourceSize);
               if(bounds == null) return null;
            }
            else
            {
               // Compatibility with an otherwise valid legacy manifest.  Do
               // not invent 1200x660: the manifest's own dimensions are the
               // only safe legacy render bounds.
               bounds = { x:0, y:0, width:sourceSize.width, height:sourceSize.height };
            }
         }
         if(parentHasMetadata && !backgroundChildAgrees(childState,mode,windows,bounds)) return null;
         return { mode:mode, windows:windows, bounds:bounds };
      }

      private function timelineChildState():Object
      {
         try
         {
            if(_skillTimelineClip && _skillTimelineClip["getTimelineState"] is Function)
               return _skillTimelineClip["getTimelineState"]();
         }
         catch(ignoredChildState:*) {}
         return null;
      }

      private function normalizeBackgroundMode(value:*):String
      {
         if(value == null) return "";
         var mode:String = String(value).toLowerCase().replace(/^\s+|\s+$/g,"");
         return mode == "none" || mode == "viewport" || mode == "fullscreen" ? mode : "";
      }

      private function finiteNumber(value:*):Boolean
      {
         var number:Number = Number(value);
         return !isNaN(number) && isFinite(number);
      }

      private function timelineSourceSize():Object
      {
         if(_skillTimeline == null || !finiteNumber(_skillTimeline.width) ||
            !finiteNumber(_skillTimeline.height)) return null;
         var width:Number = Number(_skillTimeline.width);
         var height:Number = Number(_skillTimeline.height);
         return width > 0 && height > 0 ? { width:width, height:height } : null;
      }

      private function normalizeRenderBounds(value:Object,sourceSize:Object):Object
      {
         if(value == null || sourceSize == null || !finiteNumber(value.x) ||
            !finiteNumber(value.y) || !finiteNumber(value.width) ||
            !finiteNumber(value.height)) return null;
         var x:Number = Number(value.x);
         var y:Number = Number(value.y);
         var width:Number = Number(value.width);
         var height:Number = Number(value.height);
         if(x < 0 || y < 0 || width <= 0 || height <= 0 ||
            x + width > Number(sourceSize.width) + .001 ||
            y + height > Number(sourceSize.height) + .001) return null;
         return { x:x, y:y, width:width, height:height };
      }

      private function normalizeBackgroundWindows(value:Array,mode:String):Array
      {
         var result:Array = [];
         for each(var item:Object in value)
         {
            if(item == null || !finiteNumber(item.startSeconds) ||
               !finiteNumber(item.endSeconds)) return null;
            var start:Number = Number(item.startSeconds);
            var end:Number = Number(item.endSeconds);
            if(start < 0 || end <= start) return null;
            if(item.hasOwnProperty("backgroundMode") &&
               normalizeBackgroundMode(item.backgroundMode) != mode) return null;
            if(item.hasOwnProperty("mode") &&
               normalizeBackgroundMode(item.mode) != mode) return null;
            result.push({ startSeconds:start, endSeconds:end });
         }
         result.sortOn("startSeconds",Array.NUMERIC);
         for(var index:int = 1; index < result.length; index++)
            if(Number(result[index].startSeconds) < Number(result[index - 1].endSeconds)) return null;
         return result;
      }

      private function backgroundChildAgrees(child:Object,mode:String,windows:Array,bounds:Object):Boolean
      {
         if(child == null) return true;
         if(child.hasOwnProperty("action") && String(child.action || "").toLowerCase() !=
            _skillTimelineAction) return false;
         if(child.hasOwnProperty("backgroundMode") &&
            normalizeBackgroundMode(child.backgroundMode) != mode) return false;
         if(child.hasOwnProperty("backgroundWindows"))
         {
            if(!(child.backgroundWindows is Array)) return false;
            var childWindows:Array = normalizeBackgroundWindows(child.backgroundWindows,mode);
            if(childWindows == null || childWindows.length != windows.length) return false;
            for(var index:int = 0; index < windows.length; index++)
               if(Math.abs(Number(childWindows[index].startSeconds) -
                  Number(windows[index].startSeconds)) > .001 ||
                  Math.abs(Number(childWindows[index].endSeconds) -
                  Number(windows[index].endSeconds)) > .001) return false;
         }
         if(bounds != null && child.hasOwnProperty("backgroundGeometry"))
         {
            var sourceSize:Object = timelineSourceSize();
            var geometry:Object = child.backgroundGeometry;
            if(geometry == null || !geometry.hasOwnProperty("renderBounds")) return false;
            var childBounds:Object = normalizeRenderBounds(geometry.renderBounds,sourceSize);
            if(childBounds == null || Math.abs(Number(childBounds.x) - Number(bounds.x)) > .001 ||
               Math.abs(Number(childBounds.y) - Number(bounds.y)) > .001 ||
               Math.abs(Number(childBounds.width) - Number(bounds.width)) > .001 ||
               Math.abs(Number(childBounds.height) - Number(bounds.height)) > .001) return false;
         }
         return true;
      }

      private function currentTimelineBackgroundMode():String
      {
         var metadata:Object = currentTimelineBackgroundMetadata();
         return metadata ? String(metadata.mode) : "none";
      }

      private function activeTimelineBackground():Object
      {
         if(!_skillTimelineActive || !_action) return null;
         var metadata:Object = currentTimelineBackgroundMetadata();
         if(metadata == null || metadata.mode == "none") return null;
         var elapsed:Number = _action.elapsedSeconds;
         if(!finiteNumber(elapsed)) return null;
         for each(var window:Object in metadata.windows)
            if(elapsed >= Number(window.startSeconds) && elapsed < Number(window.endSeconds))
               return metadata;
         return null;
      }

      private function syncBattleBackdrop():void
      {
         var background:Object = activeTimelineBackground();
         if(background == null)
         {
            detachBattleBackdrop();
            return;
         }
         updateBattleBackdrop(background);
      }

      private function updateBattleBackdrop(background:Object):void
      {
         if(_battleBackdropHost == null || !_skillTimelineActive ||
            _skillTimelineLoader == null || background == null || background.bounds == null)
         {
            detachBattleBackdrop();
            return;
         }
         var bounds:Object = background.bounds;
         var topLeft:Point;
         var topRight:Point;
         var bottomRight:Point;
         var bottomLeft:Point;
         try
         {
            topLeft = _battleBackdropHost.globalToLocal(_skillTimelineLoader.localToGlobal(
               new Point(Number(bounds.x),Number(bounds.y))));
            topRight = _battleBackdropHost.globalToLocal(_skillTimelineLoader.localToGlobal(
               new Point(Number(bounds.x) + Number(bounds.width),Number(bounds.y))));
            bottomRight = _battleBackdropHost.globalToLocal(_skillTimelineLoader.localToGlobal(
               new Point(Number(bounds.x) + Number(bounds.width),
                  Number(bounds.y) + Number(bounds.height))));
            bottomLeft = _battleBackdropHost.globalToLocal(_skillTimelineLoader.localToGlobal(
               new Point(Number(bounds.x),Number(bounds.y) + Number(bounds.height))));
         }
         catch(ignoredTransform:*)
         {
            detachBattleBackdrop();
            return;
         }
         if(!finiteNumber(topLeft.x) || !finiteNumber(topLeft.y) ||
            !finiteNumber(topRight.x) || !finiteNumber(topRight.y) ||
            !finiteNumber(bottomRight.x) || !finiteNumber(bottomRight.y) ||
            !finiteNumber(bottomLeft.x) || !finiteNumber(bottomLeft.y))
         {
            detachBattleBackdrop();
            return;
         }
         if(_battleBackdrop == null) _battleBackdrop = new Shape();
         _battleBackdrop.graphics.clear();
         _battleBackdrop.graphics.beginFill(0,1);
         _battleBackdrop.graphics.moveTo(topLeft.x,topLeft.y);
         _battleBackdrop.graphics.lineTo(topRight.x,topRight.y);
         _battleBackdrop.graphics.lineTo(bottomRight.x,bottomRight.y);
         _battleBackdrop.graphics.lineTo(bottomLeft.x,bottomLeft.y);
         _battleBackdrop.graphics.lineTo(topLeft.x,topLeft.y);
         _battleBackdrop.graphics.endFill();
         if(_battleBackdrop.parent != _battleBackdropHost)
         {
            if(_battleBackdrop.parent) _battleBackdrop.parent.removeChild(_battleBackdrop);
            _battleBackdropHost.addChildAt(_battleBackdrop,0);
         }
         else if(_battleBackdropHost.getChildIndex(_battleBackdrop) != 0)
         {
            _battleBackdropHost.setChildIndex(_battleBackdrop,0);
         }
         _battleBackdrop.visible = true;
      }

      private function detachBattleBackdrop():void
      {
         if(_battleBackdrop != null && _battleBackdrop.parent != null)
            _battleBackdrop.parent.removeChild(_battleBackdrop);
         if(_battleBackdrop != null) _battleBackdrop.visible = false;
      }
      override public function get currentLabels():Array
      {
         return _labels.map(function(name:String,index:int,all:Array):FrameLabel { return new FrameLabel(name,index + 1); });
      }
      override public function get currentLabel():String { return _selected; }
      override public function get currentFrameLabel():String { return _selected; }
      override public function gotoAndStop(frame:Object,scene:String = null):void { selectAction(String(frame || "standby")); }
      override public function gotoAndPlay(frame:Object,scene:String = null):void { selectAction(String(frame || "standby")); }

      private function selectAction(value:String):void
      {
         // A new action must become transparent in this same call.  Waiting for
         // the next ENTER_FRAME would leak a previous ultimate's backdrop into
         // the first frame of an ordinary attack.
         detachBattleBackdrop();
         var name:String = String(value || "").toLowerCase();
         if(name == "stand" || name == "wait" || name == "idle") name = "standby";
         else if(name == "atk" || name == "attack1" || name == "at1" || name == "physical") name = "attack";
         else if(name == "special" || name == "magic" || name == "attack2" || name == "at2") name = "sa";
         else if(name == "property" || name == "buff" || name == "effect") name = "cp";
         else if(name == "hurt" || name == "hit" || name == "behit") name = "hited";
         // Different battle hosts use different historical ultimate aliases.
         // Canonicalise every generic alias before selecting the Spine action,
         // SkillTimeline overlay and cinematic window so none of the three
         // clocks can accidentally take a different route.
         else if(name == "ultimate" || name == "sa5" || name == "as5" || name == "attack5")
            name = bestUltimate();
         _selected = name;
         if(_action) _action.select(name);
         selectSkillTimeline(name);
         _cinematicWindow = findCinematicWindow(name);
         // Selecting the same action again is a new preview request (and is
         // also how the host restarts a repeated ultimate).  Re-arm the
         // embedded cinematic every time instead of keying it only on a label
         // change; otherwise the first loop works but later loops enter the
         // authored action with no video attached.
         if(_cinematicWindow) armEmbeddedCinematic();
         else if(!_cinematicWindow) stopEmbeddedCinematic();
         _actionStartHoldError = "";
         _actionStartHeld = (_action != null) &&
            (hasSkillTimelineAction(name) || _cinematicWindow != null);
         if(_actionStartHeld)
         {
            // Non-standby action clocks stop synchronously, before a single
            // cold-load frame can escape without its Timeline effect.
            _action.stop();
            updateActionStartHold();
         }
      }

      private function selectedTimelineChildState():Object
      {
         if(!_skillTimelineClip || !(_skillTimelineClip["getTimelineState"] is Function)) return null;
         try { return _skillTimelineClip["getTimelineState"](); }
         catch(error:*) { _skillTimelineError = String(error); }
         return null;
      }

      private function updateActionStartHold():void
      {
         if(!_actionStartHeld || !_action) return;
         if(_skillTimelinePending) startSkillTimeline();
         var timelineRequired:Boolean = hasSkillTimelineAction(_selected);
         var timelineReady:Boolean = !timelineRequired;
         if(timelineRequired && _skillTimelineReady && _skillTimelineActive)
         {
            var child:Object = selectedTimelineChildState();
            if(child && (String(child.error || "") ||
               (child.underlayEnabled === true && String(child.underlayError || ""))))
            {
               _actionStartHoldError = String(child.error || child.underlayError);
               _skillTimelineError = _actionStartHoldError;
               // Keep the base Spine model usable on a genuinely corrupt
               // overlay, but expose the failure instead of silently claiming
               // a complete composition.
               timelineReady = true;
            }
            else if(child != null && String(child.action || "").toLowerCase() == _selected)
            {
               var loaded:Array = child.loadedActions is Array ? child.loadedActions as Array : [];
               timelineReady = loaded.indexOf(_selected) >= 0 &&
                  (child.underlayEnabled !== true || child.underlayReady === true);
            }
         }
         var cinematicReady:Boolean = _cinematicWindow == null || _cinematicReady;
         if(!timelineReady || !cinematicReady) return;
         if(timelineRequired && _skillTimelineClip)
         {
            try
            {
               // The initial select starts the asynchronous Loader and is
               // accepted while inactive. Re-select now that the selected
               // foreground/underlay is ready, then seek the complete
               // composition to its real first frame.
               _skillTimelineClip["selectTimelineAction"](_selected);
               _skillTimelineClip["seekTimelineSeconds"](0);
               _skillTimelineActive = true;
               if(_skillTimelineLoader && !_skillTimelineLoader.parent && stage)
               {
                  var sourceSizeHold:Object = timelineSourceSize();
                  if(sourceSizeHold != null)
                  {
                     var mirroredHold:Boolean = transform.concatenatedMatrix.a < 0;
                     var scaleXHold:Number = stage.stageWidth / Number(sourceSizeHold.width);
                     var scaleYHold:Number = stage.stageHeight / Number(sourceSizeHold.height);
                     _skillTimelineLoader.scaleX = mirroredHold ? -scaleXHold : scaleXHold;
                     _skillTimelineLoader.scaleY = scaleYHold;
                     _skillTimelineLoader.x = mirroredHold ? stage.stageWidth : 0;
                     _skillTimelineLoader.y = 0;
                  }
                  stage.addChild(_skillTimelineLoader);
               }
            }
            catch(error:*) { _skillTimelineError = String(error); }
         }
         _actionStartHeld = false;
         _action.play();
      }

      private function findCinematicWindow(action:String):Object
      {
         if(!_cinematic || _cinematic.enabled !== true || !(_cinematic.windows is Array)) return null;
         for each(var window:Object in _cinematic.windows)
            if(String(window.action || "").toLowerCase() == action) return window;
         return null;
      }

      private function prepareEmbeddedCinematic():void
      {
         if(!_cinematic || _cinematic.enabled !== true) return;
         try
         {
            _cinematicLoader = new Loader();
            _cinematicLoader.mouseEnabled = false;
            _cinematicLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,onCinematicLoaded,false,0,true);
            _cinematicLoader.loadBytes(new CinematicBytes() as ByteArray,
               new LoaderContext(false,ApplicationDomain.currentDomain));
         }
         catch(error:*) { _initError += (_initError ? "; " : "") + "embedded cinematic: " + String(error); }
      }

      private function onCinematicLoaded(event:Event):void
      {
         _cinematicReady = true;
         _cinematicClip = _cinematicLoader.content as MovieClip;
         if(_cinematicClip) { _cinematicClip.stop(); _cinematicClip.gotoAndStop(1); }
         if(_actionStartHeld) updateActionStartHold();
         if(_cinematicPending) onActionTimelineEnterFrame(null);
      }
      private function onAddedToStage(event:Event):void
      {
         if(_skillTimelinePending) startSkillTimeline();
         if(_cinematicPending) onActionTimelineEnterFrame(null);
      }
      private function armEmbeddedCinematic():void { stopEmbeddedCinematic(); _cinematicPending = true; }

      private function onActionTimelineEnterFrame(event:Event):void
      {
         if(_actionStartHeld)
         {
            updateActionStartHold();
            if(_actionStartHeld) return;
         }
         if(_action && (_skillTimelinePending || _skillTimelineActive))
         {
            if(_skillTimelinePending) startSkillTimeline();
            if(_skillTimelineActive && _skillTimelineClip)
            {
               try
               {
                  var remainsActive:* = _skillTimelineClip["seekTimelineSeconds"](_action.elapsedSeconds);
                  if(remainsActive === false) stopSkillTimeline(false);
                  else syncBattleBackdrop();
               }
               catch(timelineSeekError:*)
               {
                  _skillTimelineError = String(timelineSeekError);
                  stopSkillTimeline(false);
               }
            }
         }
         if(!_cinematicWindow || !_action) return;
         var elapsed:Number = _action.elapsedSeconds;
         var start:Number = Number(_cinematicWindow.startSeconds);
         var end:Number = Number(_cinematicWindow.endSeconds);
         if(_cinematicActive)
         {
            if(elapsed >= end) { stopEmbeddedCinematic(); return; }
            seekEmbeddedCinematic(elapsed);
            return;
         }
         if(_cinematicPending && elapsed >= start && elapsed < end) startEmbeddedCinematic();
      }

      private function startEmbeddedCinematic():void
      {
         _cinematicPending = true;
         if(!_cinematicReady || !_cinematicClip || !stage || !_cinematicWindow) return;
         var elapsed:Number = _action ? _action.elapsedSeconds : 0;
         var start:Number = Number(_cinematicWindow.startSeconds);
         var end:Number = Number(_cinematicWindow.endSeconds);
         if(elapsed < start || elapsed >= end) return;
         _cinematicPending = false;
         _cinematicActive = true;
         if(_cinematicLoader.parent) _cinematicLoader.parent.removeChild(_cinematicLoader);
         var mirrored:Boolean = transform.concatenatedMatrix.a < 0;
         var scaleXVal:Number = stage.stageWidth / 1200;
         var scaleYVal:Number = stage.stageHeight / 660;
         _cinematicLoader.scaleX = mirrored ? -scaleXVal : scaleXVal;
         _cinematicLoader.scaleY = scaleYVal;
         _cinematicLoader.x = mirrored ? stage.stageWidth : 0;
         _cinematicLoader.y = 0;
         stage.addChild(_cinematicLoader);
         seekEmbeddedCinematic(elapsed);
      }

      private function seekEmbeddedCinematic(elapsed:Number):void
      {
         if(!_cinematicActive || !_cinematicClip || !_cinematicWindow) return;
         var start:Number = Number(_cinematicWindow.startSeconds);
         var rate:Number = Math.max(1,Number(_cinematicWindow.frameRate) || 30);
         var frame:int = Math.max(1,Math.min(_cinematicClip.totalFrames,
            1 + int(Math.max(0,elapsed - start) * rate)));
         // The action clock is authoritative for the video, native Timeline
         // particles and hit signal.  Seeking instead of gotoAndPlay prevents a
         // dropped Flash frame from delaying the video and hiding the official
         // post-video hit/xuli/6 particle tail on repeated previews.
         if(_cinematicClip.currentFrame != frame) _cinematicClip.gotoAndStop(frame);
      }

      private function stopEmbeddedCinematic():void
      {
         _cinematicPending = false; _cinematicActive = false;
         if(_cinematicLoader && _cinematicLoader.parent) _cinematicLoader.parent.removeChild(_cinematicLoader);
         if(_cinematicClip)
         {
            _cinematicClip.stop(); _cinematicClip.gotoAndStop(1);
         }
      }
      private function onRemovedFromStage(event:Event):void
      {
         stopEmbeddedCinematic();
         // Battle hosts may temporarily detach and reattach the same fighter.
         // Detachment therefore stops and unparents the overlay but keeps its
         // embedded wrapper configured. Permanent teardown is explicit via
         // disposeUClientBattleResources() (and the outer Loader's
         // unloadAndStop), so reattachment cannot inherit a disposed wrapper.
         stopSkillTimeline(false);
         detachBattleBackdrop();
      }

      public function disposeUClientBattleResources():void
      {
         stopEmbeddedCinematic();
         stopSkillTimeline(true);
         removeEventListener(Event.ADDED_TO_STAGE,onAddedToStage);
         removeEventListener(Event.REMOVED_FROM_STAGE,onRemovedFromStage);
         removeEventListener(Event.ENTER_FRAME,onActionTimelineEnterFrame);
         if(_skillTimelineLoader)
         {
            try
            {
               _skillTimelineLoader.contentLoaderInfo.removeEventListener(
                  Event.COMPLETE,onSkillTimelineLoaded);
               _skillTimelineLoader.unloadAndStop(true);
            }
            catch(ignoredSkillUnload:*) {}
         }
         if(_cinematicLoader)
         {
            try
            {
               _cinematicLoader.contentLoaderInfo.removeEventListener(
                  Event.COMPLETE,onCinematicLoaded);
               _cinematicLoader.unloadAndStop(true);
            }
            catch(ignoredCinematicUnload:*) {}
         }
         _skillTimelineLoader = null;
         _skillTimelineClip = null;
         _skillTimelineReady = false;
         _actionStartHeld = false;
         _actionStartHoldError = "";
         detachBattleBackdrop();
         _battleBackdropHost = null;
         _battleBackdrop = null;
         _cinematicLoader = null;
         _cinematicClip = null;
         _cinematicReady = false;
      }

      private function prepareSkillTimeline():void
      {
         if(!_skillTimeline || _skillTimeline.enabled !== true) return;
         try
         {
            _skillTimelineLoader = new Loader();
            _skillTimelineLoader.mouseEnabled = false;
            _skillTimelineLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,onSkillTimelineLoaded,false,0,true);
            _skillTimelineLoader.loadBytes(new SkillTimelineBytes() as ByteArray,
               new LoaderContext(false,ApplicationDomain.currentDomain));
         }
         catch(error:*) { _skillTimelineError = String(error); }
      }

      private function onSkillTimelineLoaded(event:Event):void
      {
         _skillTimelineClip = _skillTimelineLoader ? _skillTimelineLoader.content : null;
         if(!_skillTimelineClip)
         {
            _skillTimelineError = "embedded SkillTimeline overlay did not expose a display root";
            return;
         }
         try
         {
            if(_skillTimelineClip["configureTimeline"] is Function)
               _skillTimelineClip["configureTimeline"](_skillTimeline);
            if(!(_skillTimelineClip["selectTimelineAction"] is Function) ||
               !(_skillTimelineClip["seekTimelineSeconds"] is Function))
               throw new Error("embedded SkillTimeline overlay contract is incomplete");
            _skillTimelineReady = true;
            if(_skillTimelinePending) startSkillTimeline();
         }
         catch(error:*) { _skillTimelineError = String(error); }
      }

      private function skillTimelineActionRecord(action:String):Object
      {
         var actions:Array = _skillTimeline && _skillTimeline.actions is Array ?
            _skillTimeline.actions as Array : [];
         for each(var item:Object in actions)
            if(String(item && item.action || "").toLowerCase() == action) return item;
         return null;
      }

      private function hasSkillTimelineAction(action:String):Boolean
      {
         return skillTimelineActionRecord(action) != null;
      }

      private function selectSkillTimeline(action:String):void
      {
         _skillTimelineAction = String(action || "").toLowerCase();
         if(!_skillTimeline || _skillTimeline.enabled !== true ||
            !hasSkillTimelineAction(_skillTimelineAction))
         {
            stopSkillTimeline(false);
            return;
         }
         // The wrapper owns action switching. Sending an empty action here used
         // to discard the decoded clip before every loop, forcing another cold
         // loadBytes and recreating the first-loop blank effect.
         _skillTimelineActive = false;
         detachBattleBackdrop();
         _skillTimelinePending = true;
         startSkillTimeline();
      }

      private function startSkillTimeline():void
      {
         if(!_skillTimelinePending || !_skillTimelineReady || !_skillTimelineLoader ||
            !_skillTimelineClip || !stage) return;
         try
         {
            var accepted:* = _skillTimelineClip["selectTimelineAction"](_skillTimelineAction);
            if(accepted === false)
            {
               _skillTimelinePending = false;
               return;
            }
            _skillTimelinePending = false;
            _skillTimelineActive = true;
            var sourceSize:Object = timelineSourceSize();
            if(sourceSize == null) throw new Error("SkillTimeline source geometry is invalid");
            var sourceWidth:Number = Number(sourceSize.width);
            var sourceHeight:Number = Number(sourceSize.height);
            var mirrored:Boolean = transform.concatenatedMatrix.a < 0;
            var scaleXVal:Number = stage.stageWidth / sourceWidth;
            var scaleYVal:Number = stage.stageHeight / sourceHeight;
            _skillTimelineLoader.scaleX = mirrored ? -scaleXVal : scaleXVal;
            _skillTimelineLoader.scaleY = scaleYVal;
            _skillTimelineLoader.x = mirrored ? stage.stageWidth : 0;
            _skillTimelineLoader.y = 0;
            // The native action SWFs are black-flattened videos. Their inner
            // loaders already use SCREEN, but that blend can be resolved inside
            // the loaded overlay before the outer Loader is composited. Keep the
            // outer Loader on SCREEN as well so black remains transparent over
            // the battle while the dedicated backdrop stays at host index 0.
            _skillTimelineLoader.blendMode = BlendMode.SCREEN;
            if(_skillTimelineLoader.parent) _skillTimelineLoader.parent.removeChild(_skillTimelineLoader);
            stage.addChild(_skillTimelineLoader);
            // The official video is a window inside the same Timeline. Keep it
            // above the transparent effect layer without stopping either the
            // Spine action clock or this overlay clock.
            if(_cinematicActive && _cinematicLoader && _cinematicLoader.parent)
               stage.addChild(_cinematicLoader);
            // Compute backdrop geometry only after the overlay has its final
            // stage scale/position; localToGlobal must observe that transform.
            syncBattleBackdrop();
         }
         catch(error:*)
         {
            _skillTimelineError = String(error);
            stopSkillTimeline(false);
         }
      }

      private function stopSkillTimeline(dispose:Boolean):void
      {
         _skillTimelinePending = false;
         _skillTimelineActive = false;
         detachBattleBackdrop();
         if(_skillTimelineLoader && _skillTimelineLoader.parent)
            _skillTimelineLoader.parent.removeChild(_skillTimelineLoader);
         if(_skillTimelineClip)
         {
            try
            {
               if(dispose && _skillTimelineClip["disposeTimeline"] is Function)
                  _skillTimelineClip["disposeTimeline"]();
               else if(_skillTimelineClip["pauseTimeline"] is Function)
                  _skillTimelineClip["pauseTimeline"]();
               else if(_skillTimelineClip["selectTimelineAction"] is Function)
                  _skillTimelineClip["selectTimelineAction"]("");
            }
            catch(ignored:*) {}
         }
      }

      private function bestUltimate():String
      {
         for each(var name:String in _labels)
            if(/^moves?[_-]?\d+/i.test(name) || /^(sa5|as5|attack5|hidemove|ultimate)/i.test(name)) return name;
         return "attack";
      }
      private function selectActionForTest(value:String):Object { selectAction(value); return getBattleState(); }
      private function selectFrameForTest(value:String,frame:int):Object
      { selectAction(value); if(_action) _action.gotoAndStop(Math.max(1,frame)); return getBattleState(); }
      private function getBattleState():Object
      {
         return { label:_selected, frame:_action ? _action.currentFrame : 0,
            total:_action ? _action.totalFrames : 0, hit:_action ? _action.hit : 0,
            fps:30, ready:_action != null && _action.ready, error:_initError,
            renderer:_action ? _action.rendererMode : "cpu-spine40-init-failed",
            rendererDiagnostics:_action ? _action.rendererDiagnostics : null,
            skillTimeline:getSkillTimelineState(),cinematic:getEmbeddedCinematicState() };
      }
      private function getBattleVisualDigest():Object
      { return _action ? _action.visualDigest() : { empty:true,error:_initError }; }
      public function getEmbeddedCinematicState():Object
      {
         return { enabled:_cinematic != null && _cinematic.enabled === true,
            ready:_cinematicReady,pending:_cinematicPending,active:_cinematicActive,
            attached:_cinematicLoader != null && _cinematicLoader.parent != null,
            action:_selected,frame:_cinematicClip ? _cinematicClip.currentFrame : 0,
            total:_cinematicClip ? _cinematicClip.totalFrames : 0,
            actionElapsed:_action ? _action.elapsedSeconds : 0 };
      }
      public function getSkillTimelineState():Object
      {
         var childState:Object = null;
         try
         {
            if(_skillTimelineClip && _skillTimelineClip["getTimelineState"] is Function)
               childState = _skillTimelineClip["getTimelineState"]();
         }
         catch(ignored:*) {}
         return { enabled:_skillTimeline != null && _skillTimeline.enabled === true,
            ready:_skillTimelineReady,pending:_skillTimelinePending,active:_skillTimelineActive,
            attached:_skillTimelineLoader != null && _skillTimelineLoader.parent != null,
            action:_skillTimelineAction,elapsed:_action ? _action.elapsedSeconds : 0,
            backgroundMode:currentTimelineBackgroundMode(),error:_skillTimelineError,child:childState,
            actionStartHeld:_actionStartHeld,actionStartHoldError:_actionStartHoldError };
      }
      // Direct AS3 hosts cannot call an ExternalInterface callback name. Expose
      // the same public name used by the previewer and Projector diagnostics.
      public function getUClientSkillTimelineState():Object
      {
         return getSkillTimelineState();
      }
   }
}
