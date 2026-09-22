package
{
   import flash.display.FrameLabel;
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.display.DisplayObjectContainer;
   import flash.events.ErrorEvent;
   import flash.external.ExternalInterface;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.utils.ByteArray;
   import flash.geom.Rectangle;

   [SWF(width="1200", height="660", frameRate="24", backgroundColor="#000000")]
   public class pet extends MovieClip
   {
      [Embed(source="placeholder.json", mimeType="application/octet-stream")]
      private static const ManifestBytes:Class;
      [Embed(source="event-video-placeholder-0.bin", mimeType="application/octet-stream")] private static const EventVideo0:Class;
      [Embed(source="event-video-placeholder-1.bin", mimeType="application/octet-stream")] private static const EventVideo1:Class;
      [Embed(source="event-video-placeholder-2.bin", mimeType="application/octet-stream")] private static const EventVideo2:Class;
      [Embed(source="event-video-placeholder-3.bin", mimeType="application/octet-stream")] private static const EventVideo3:Class;
      [Embed(source="event-video-placeholder-4.bin", mimeType="application/octet-stream")] private static const EventVideo4:Class;
      [Embed(source="event-video-placeholder-5.bin", mimeType="application/octet-stream")] private static const EventVideo5:Class;
      [Embed(source="event-video-placeholder-6.bin", mimeType="application/octet-stream")] private static const EventVideo6:Class;
      [Embed(source="event-video-placeholder-7.bin", mimeType="application/octet-stream")] private static const EventVideo7:Class;
      include "UClientFtrAtlasFactories.inc";

      private var _action:UClientFtrActionClip = new UClientFtrActionClip();
      private var _manifest:Object;
      private var _labels:Array = ["idle", "attack", "sa", "cp", "hited"];
      private var _selected:String = "standby";
      private var _eventVideoFactories:Array = [EventVideo0,EventVideo1,EventVideo2,EventVideo3,
         EventVideo4,EventVideo5,EventVideo6,EventVideo7];
      private var _eventVideoLoader:Loader;
      private var _eventVideoClip:MovieClip;
      private var _eventVideoRecord:Object;
      private var _eventVideoEpoch:uint = 0;
      private var _eventVideoLoading:Boolean = false;
      private var _eventVideoActive:Boolean = false;
      private var _eventVideoLoadTicks:int = 0;
      private var _eventVideoError:String = "";
      private var _eventVideoQueue:Array = [];
      // The battle SWF is also reused by the standalone preview player.  Keep
      // this opt-in so real battle playback retains its authored stop/resume
      // contract while the preview can loop a cinematic without exposing the
      // blank action frames between two video instances.
      private var _previewLoop:Boolean = false;

      public function pet()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         var bytes:ByteArray = new ManifestBytes() as ByteArray;
         bytes.position = 0;
         _manifest = JSON.parse(bytes.readUTFBytes(bytes.length));
         var pageCount:int = _manifest && _manifest.pages is Array ? _manifest.pages.length : 0;
         var pageFactories:Array = createAtlasFactories(pageCount);
         var pages:Array = new Array(pageFactories.length);
         var names:Array = [];
         for each(var sequence:Object in _manifest.sequences)
         {
            var name:String = String(sequence.name || "").toLowerCase();
            if(name && names.indexOf(name) < 0) names.push(name);
         }
         if(names.indexOf("standby") >= 0 && names.indexOf("idle") < 0) names.unshift("idle");
         if(names.length) _labels = names;
         var anchorOffsetY:Number = Number(_manifest && _manifest.anchorOffsetY || 0);
         if(isNaN(anchorOffsetY) || anchorOffsetY < 0 || anchorOffsetY > 10000) anchorOffsetY = 0;
         _action.y = 145 + anchorOffsetY;
         addChild(_action);
         _action.install(_manifest,pages,pageFactories);
         _action.addEventListener(UClientFtrFrameEvent.EVENT_VIDEO,onEventVideo,false,0,true);
         addEventListener(Event.ENTER_FRAME,onEventVideoTimeline,false,0,true);
         addEventListener(Event.REMOVED_FROM_STAGE,onRemovedFromStage,false,0,true);
         selectAction("standby");
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.addCallback("setUClientFtrBattleAction",selectActionForTest);
               ExternalInterface.addCallback("setUClientFtrBattleFrame",selectFrameForTest);
               ExternalInterface.addCallback("getUClientFtrBattleState",getBattleState);
               ExternalInterface.addCallback("getUClientFtrBattleVisualDigest",getBattleVisualDigest);
               ExternalInterface.addCallback("cycleUClientFtrBattleDisplay",cycleBattleDisplayForTest);
               ExternalInterface.addCallback("getUClientFtrEventVideoState",getEventVideoState);
            }
         }
         catch(error:*) {}
      }

      public function get uClientBattleReady():Boolean { return true; }
      public function get uClientBattleClockManaged():Boolean { return true; }

      public function setPreviewLooping(value:*):Boolean
      {
         _previewLoop = value === true || String(value) == "1" || String(value).toLowerCase() == "true";
         return _previewLoop;
      }

      override public function get currentLabels():Array
      {
         return _labels.map(function(name:String,index:int,all:Array):FrameLabel {
            return new FrameLabel(name,index + 1);
         });
      }

      override public function get currentLabel():String { return _selected; }
      override public function get currentFrameLabel():String { return _selected; }
      override public function gotoAndStop(frame:Object,scene:String = null):void { selectAction(String(frame || "standby")); }
      override public function gotoAndPlay(frame:Object,scene:String = null):void { selectAction(String(frame || "standby")); }

      private function selectAction(value:String):void
      {
         _eventVideoQueue.length = 0;
         stopEventVideo(false);
         var name:String = String(value || "").toLowerCase();
         if(name == "stand" || name == "wait" || name == "idle") name = "standby";
         else if(name == "atk" || name == "attack1") name = "attack";
         else if(name == "special" || name == "magic") name = "sa";
         else if(name == "property" || name == "buff") name = "cp";
         else if(name == "hurt" || name == "hit" || name == "behit") name = "hited";
         else if(name == "hidemove" || name == "ultimate") name = bestUltimate();
         _selected = name;
         _action.select(name);
      }

      private function findEventVideo(event:UClientFtrFrameEvent):Object
      {
         var records:Array = _manifest && _manifest.eventVideos is Array ? _manifest.eventVideos as Array : [];
         for each(var record:Object in records)
         {
            if(String(record.clip || "").toLowerCase() != event.clip.toLowerCase()) continue;
            var triggers:Array = record.triggers is Array ? record.triggers as Array : [];
            for each(var trigger:Object in triggers)
            {
               if(String(trigger.action || "").toLowerCase() == event.actionName.toLowerCase() &&
                  int(trigger.frame) == event.sourceFrame &&
                  String(trigger.label || "").toLowerCase() == event.label.toLowerCase()) return record;
            }
         }
         return null;
      }

      private function onEventVideo(raw:UClientFtrFrameEvent):void
      {
         if(_eventVideoLoading || _eventVideoActive)
         {
            _eventVideoQueue.push(raw.clone());
            return;
         }
         startEventVideo(raw,false);
      }

      private function startEventVideo(raw:UClientFtrFrameEvent, actionAlreadyPaused:Boolean):void
      {
         var record:Object = findEventVideo(raw);
         if(record == null) return;
         var slot:int = int(record.slot);
         if(slot < 0 || slot >= _eventVideoFactories.length) return;
         if(!actionAlreadyPaused &&
            !_action.pauseForEmbeddedVideo(raw.actionEpoch,raw.actionName,raw.sourceFrame)) return;
         if(actionAlreadyPaused && (!_action.eventPaused || raw.actionEpoch != _action.actionEpoch)) return;
         _eventVideoRecord = record;
         _eventVideoEpoch = raw.actionEpoch;
         _eventVideoLoading = true;
         _eventVideoLoadTicks = 0;
         _eventVideoError = "";
         try
         {
            _eventVideoLoader = new Loader();
            _eventVideoLoader.mouseEnabled = false;
            _eventVideoLoader.contentLoaderInfo.addEventListener(Event.COMPLETE,onEventVideoLoaded,false,0,true);
            _eventVideoLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,onEventVideoError,false,0,true);
            var factory:Class = _eventVideoFactories[slot] as Class;
            _eventVideoLoader.loadBytes(new factory() as ByteArray,
               new LoaderContext(false,ApplicationDomain.currentDomain));
         }
         catch(error:*)
         {
            _eventVideoError = String(error);
            stopEventVideo(true);
         }
      }

      private function onEventVideoLoaded(event:Event):void
      {
         if(!_eventVideoLoading || !_eventVideoLoader) return;
         _eventVideoClip = _eventVideoLoader.content as MovieClip;
         if(!_eventVideoClip || !stage)
         {
            _eventVideoError = "embedded event video did not expose a MovieClip stage";
            stopEventVideo(true);
            return;
         }
         _eventVideoLoading = false;
         _eventVideoActive = true;
         var sourceWidth:Number = Math.max(1,Number(_eventVideoRecord && _eventVideoRecord.width || 1200));
         var sourceHeight:Number = Math.max(1,Number(_eventVideoRecord && _eventVideoRecord.height || 660));
         var fit:Number = Math.max(stage.stageWidth / sourceWidth,stage.stageHeight / sourceHeight);
         var mirrored:Boolean = transform.concatenatedMatrix.a < 0;
         _eventVideoLoader.scaleX = mirrored ? -fit : fit;
         _eventVideoLoader.scaleY = fit;
         _eventVideoLoader.x = mirrored ? (stage.stageWidth + sourceWidth * fit) / 2 :
            (stage.stageWidth - sourceWidth * fit) / 2;
         _eventVideoLoader.y = (stage.stageHeight - sourceHeight * fit) / 2;
         stage.addChild(_eventVideoLoader);
         _eventVideoClip.stop();
         _eventVideoClip.gotoAndPlay(1);
      }

      private function onEventVideoError(event:ErrorEvent):void
      {
         _eventVideoError = event ? event.text : "embedded event video load failed";
         stopEventVideo(true);
      }

      private function onEventVideoTimeline(event:Event):void
      {
         if(_eventVideoLoading)
         {
            _eventVideoLoadTicks++;
            if(_eventVideoLoadTicks > 120)
            {
               _eventVideoError = "embedded event video load timed out";
               stopEventVideo(true);
            }
            return;
         }
         if(_eventVideoActive && _eventVideoClip && _eventVideoClip.totalFrames > 1 &&
            _eventVideoClip.currentFrame >= _eventVideoClip.totalFrames)
         {
            if(_previewLoop)
            {
               // Keep the action clock paused and restart the already-loaded
               // cinematic in place.  Unloading/reloading here briefly exposes
               // the authored blank frames and is the source of the first-loop
               // only behaviour seen in the local preview window.
               try
               {
                  _eventVideoClip.gotoAndStop(1);
                  _eventVideoClip.gotoAndPlay(1);
                  return;
               }
               catch(ignoredRestart:*) {}
            }
            stopEventVideo(true);
         }
      }

      private function stopEventVideo(resumeAction:Boolean):void
      {
         var resumeEpoch:uint = _eventVideoEpoch;
         _eventVideoLoading = false;
         _eventVideoActive = false;
         _eventVideoLoadTicks = 0;
         if(_eventVideoLoader)
         {
            try
            {
               _eventVideoLoader.contentLoaderInfo.removeEventListener(Event.COMPLETE,onEventVideoLoaded);
               _eventVideoLoader.contentLoaderInfo.removeEventListener(IOErrorEvent.IO_ERROR,onEventVideoError);
            }
            catch(error:*) {}
            if(_eventVideoLoader.parent) _eventVideoLoader.parent.removeChild(_eventVideoLoader);
            try { _eventVideoLoader.unloadAndStop(true); } catch(unloadError:*) {}
         }
         _eventVideoLoader = null;
         _eventVideoClip = null;
         _eventVideoRecord = null;
         _eventVideoEpoch = 0;
         if(resumeAction && _eventVideoQueue.length)
         {
            var next:UClientFtrFrameEvent = _eventVideoQueue.shift() as UClientFtrFrameEvent;
            if(next && next.actionEpoch == resumeEpoch)
            {
               startEventVideo(next,true);
               if(_eventVideoLoading || _eventVideoActive) return;
            }
         }
         _eventVideoQueue.length = 0;
         if(resumeAction) _action.resumeFromEmbeddedVideo(resumeEpoch);
      }

      private function onRemovedFromStage(event:Event):void
      {
         _eventVideoQueue.length = 0;
         stopEventVideo(true);
      }

      private function bestUltimate():String
      {
         for each(var name:String in _labels)
         {
            if(/^moves?[_-]?\d+/i.test(name) || /^(sa5|as5|attack5|hidemove|ultimate)/i.test(name)) return name;
         }
         return "attack";
      }

      private function selectActionForTest(value:String):Object
      {
         selectAction(value);
         return getBattleState();
      }

      private function selectFrameForTest(value:String,frame:int):Object
      {
         selectAction(value);
         _action.gotoAndStop(Math.max(1,frame));
         return getBattleState();
      }

      private function getBattleState():Object
      {
         return {
            label:_selected,
            frame:_action.currentFrame,
            total:_action.totalFrames,
            hit:_action.hit,
            fps:_manifest && _manifest.frameRate ? Number(_manifest.frameRate) : 24,
            ready:_action.ready,
            renderer:_action.rendererMode,
            rendererDiagnostics:_action.rendererDiagnostics,
            eventVideo:getEventVideoState()
         };
      }

      private function getEventVideoState():Object
      {
         return {
            loading:_eventVideoLoading,active:_eventVideoActive,paused:_action.eventPaused,
            epoch:_eventVideoEpoch,clip:String(_eventVideoRecord && _eventVideoRecord.clip || ""),
            frame:_eventVideoClip ? _eventVideoClip.currentFrame : 0,
            total:_eventVideoClip ? _eventVideoClip.totalFrames : 0,error:_eventVideoError
         };
      }

      private function getBattleVisualDigest():Object
      {
         return _action.visualDigest();
      }

      private function cycleBattleDisplayForTest():Object
      {
         if(_action.parent === this) removeChild(_action);
         addChild(_action);
         return getBattleState();
      }
   }
}
