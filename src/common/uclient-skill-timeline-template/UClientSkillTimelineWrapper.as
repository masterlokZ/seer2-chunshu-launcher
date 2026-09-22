package
{
   import flash.display.BlendMode;
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;

   [SWF(width="1200",height="660",frameRate="30",backgroundColor="#000000")]
   public class UClientSkillTimelineWrapper extends Sprite
   {
      [Embed(source="action-appear-placeholder.bin",mimeType="application/octet-stream")]
      private static const ActionAppear:Class;
      [Embed(source="action-attack-placeholder.bin",mimeType="application/octet-stream")]
      private static const ActionAttack:Class;
      [Embed(source="action-cp-placeholder.bin",mimeType="application/octet-stream")]
      private static const ActionCp:Class;
      [Embed(source="action-hidemove-placeholder.bin",mimeType="application/octet-stream")]
      private static const ActionHidemove:Class;
      [Embed(source="action-sa-placeholder.bin",mimeType="application/octet-stream")]
      private static const ActionSa:Class;

      private var _factories:Object = {
         appear:ActionAppear,attack:ActionAttack,cp:ActionCp,hidemove:ActionHidemove,sa:ActionSa
      };
      private var _manifest:Object;
      private var _loader:Loader;
      private var _clip:MovieClip;
      private var _action:String = "";
      private var _elapsed:Number = 0;
      private var _epoch:uint = 0;
      private var _loading:Boolean = false;
      private var _ready:Boolean = false;
      private var _error:String = "";
      private var _transformMetadata:Object;

      public function UClientSkillTimelineWrapper()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         blendMode = BlendMode.SCREEN;
         visible = false;
      }

      public function configureTimeline(value:Object):Boolean
      {
         _manifest = value;
         return _manifest != null && _manifest.enabled === true;
      }

      public function selectTimelineAction(value:String):Boolean
      {
         var action:String = String(value || "").toLowerCase();
         _elapsed = 0;
         _epoch++;
         if(!action || _factories[action] == null || !actionRecord(action))
         {
            stopCurrent(false);
            _action = "";
            _transformMetadata = null;
            return false;
         }
         _transformMetadata = actionRecord(action).transformMetadata;
         if(_action == action && _ready && _clip)
         {
            _clip.gotoAndStop(1);
            _action = action;
            visible = true;
            return true;
         }
         stopCurrent(true);
         _action = action;
         _loading = true;
         _ready = false;
         _error = "";
         var requestedEpoch:uint = _epoch;
         try
         {
            _loader = new Loader();
            _loader.mouseEnabled = false;
            _loader.blendMode = BlendMode.SCREEN;
            _loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(event:Event):void {
               if(requestedEpoch != _epoch || !_loader) return;
               _loading = false;
               _clip = _loader.content as MovieClip;
               if(!_clip) { _error = "action SWF did not expose a MovieClip"; return; }
               _ready = true;
               if(!_loader.parent) addChild(_loader);
               seekTimelineSeconds(_elapsed);
            },false,0,true);
            _loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(event:IOErrorEvent):void {
               if(requestedEpoch != _epoch) return;
               _loading = false; _ready = false; _error = event.text;
            },false,0,true);
            var factory:Class = _factories[action] as Class;
            _loader.loadBytes(new factory() as ByteArray,
               new LoaderContext(false,ApplicationDomain.currentDomain));
            visible = true;
            return true;
         }
         catch(error:*)
         {
            _loading = false;
            _error = String(error);
            return false;
         }
         // Keep an explicit fall-through return for the legacy ASC compiler.
         // Some Flex SDK builds do not prove that every try/catch path above
         // returns from a Boolean method, even though both branches do.
         return false;
      }

      public function seekTimelineSeconds(value:Number):Boolean
      {
         _elapsed = Math.max(0,Number(value) || 0);
         var record:Object = actionRecord(_action);
         if(!record) { detachTimelineUnderlay(); visible = false; return false; }
         var duration:Number = Number(record.durationSeconds);
         if(_elapsed > duration + .001) { detachTimelineUnderlay(); visible = false; return false; }
         if(!_ready || !_clip) return true;
         var frameRate:Number = Math.max(1,Number(_manifest && _manifest.frameRate || 30));
         var authoredFrames:int = Math.max(2,int(record.frameCount || _clip.totalFrames));
         var frame:int = Math.max(1,Math.min(authoredFrames,1 + int(_elapsed * frameRate)));
         if(frame <= _clip.totalFrames && _clip.currentFrame != frame) _clip.gotoAndStop(frame);
         if(!timelineBackgroundWindowActive()) detachTimelineUnderlay();
         visible = true;
         return true;
      }

      private function timelineBackgroundWindowActive():Boolean
      {
         var split:Object = _manifest && _manifest.layerSplit;
         var windows:Array = [];
         if(split && split.actions is Array)
            for each(var splitAction:Object in split.actions)
               if(String(splitAction && splitAction.action || '').toLowerCase() == _action &&
                  splitAction.activeWindows is Array) { windows = splitAction.activeWindows as Array; break; }
         if(windows.length == 0 && split && split.enabled === true &&
            String(split.blendMode || 'normal').toLowerCase() == 'screen')
         {
            var legacyRecord:Object = actionRecord(_action);
            var legacyDuration:Number = Number(legacyRecord && legacyRecord.durationSeconds);
            if(legacyDuration > 0) windows = [{ startSeconds:0, endSeconds:legacyDuration }];
         }
         for each(var window:Object in windows)
         {
            var start:Number = Number(window && window.startSeconds);
            var end:Number = Number(window && window.endSeconds);
            if(!isNaN(start) && isFinite(start) && !isNaN(end) && isFinite(end) &&
               start >= 0 && end > start && _elapsed >= start && _elapsed < end) return true;
         }
         return false;
      }

      /** Optional split-channel bridge.  New generated Timeline roots expose
       * these methods; the placeholder/legacy roots simply return null/void so
       * callers can probe the capability without changing old playback. */
      public function getTimelineUnderlayDisplay():Object
      {
         if(!timelineBackgroundWindowActive())
         {
            detachTimelineUnderlay();
            return null;
         }
         try
         {
            if(_clip && _clip["getTimelineUnderlayDisplay"] is Function)
               return _clip["getTimelineUnderlayDisplay"]();
         }
         catch(ignoredUnderlay:*) {}
         return null;
      }

      public function detachTimelineUnderlay():void
      {
         try
         {
            if(_clip && _clip["detachTimelineUnderlay"] is Function)
               _clip["detachTimelineUnderlay"]();
         }
         catch(ignoredDetach:*) {}
      }

      /** Hide the current action without destroying its decoded Loader/clip.
       * Re-selecting the same action can then restart from frame 1 immediately,
       * instead of turning every preview loop into another asynchronous cold
       * load. Permanent teardown remains disposeTimeline(). */
      public function pauseTimeline():void
      {
         detachTimelineUnderlay();
         if(_clip) try { _clip.stop(); } catch(ignoredPause:*) {}
         _elapsed = 0;
         visible = false;
      }

      private function actionRecord(action:String):Object
      {
         var actions:Array = _manifest && _manifest.actions is Array ? _manifest.actions as Array : [];
         for each(var item:Object in actions)
            if(String(item && item.action || "").toLowerCase() == action) return item;
         return null;
      }

      private function stopCurrent(unload:Boolean):void
      {
         _loading = false;
         _ready = false;
         detachTimelineUnderlay();
         if(_clip) try { _clip.stop(); } catch(ignoredStop:*) {}
         _clip = null;
         visible = false;
         if(_loader)
         {
            if(_loader.parent) _loader.parent.removeChild(_loader);
            if(unload) try { _loader.unloadAndStop(true); } catch(ignored:*) {}
         }
         if(unload) _loader = null;
      }

      public function getTimelineState():Object
      {
         return { ready:_ready,loading:_loading,active:visible,action:_action,elapsed:_elapsed,
            frame:_clip ? _clip.currentFrame : 0,total:_clip ? _clip.totalFrames : 0,
            blendMode:blendMode,error:_error,epoch:_epoch,
            // This metadata is evidence only when cameraBakedIntoOverlay is true;
            // the parent pet applies any calibrated non-baked composition once to
            // Spine, overlay and cinematic on the shared action clock.
            transformMetadata:_transformMetadata,
            layerSplit:_clip && _clip["getTimelineLayerSplit"] is Function ?
               _clip["getTimelineLayerSplit"]() : null };
      }

      public function disposeTimeline():void
      {
         _epoch++;
         stopCurrent(true);
         _action = "";
         _transformMetadata = null;
         _manifest = null;
      }
   }
}
