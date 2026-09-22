package
{
   import flash.display.FrameLabel;
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.utils.ByteArray;

   /**
    * Self-contained U-client follow model.
    *
    * Seer2's follow-model hosts drive the exported `pet` class through the
    * eight legacy direction labels.  U-client FollowPackage resources author a
    * single continuous `await` animation instead, so every direction is a
    * structural view of that same official sequence.  Older extracted data may
    * call it `standby` or `idle`; no resource id participates in the choice.
    */
   [SWF(width="600", height="600", frameRate="24", backgroundColor="#000000")]
   public class pet extends MovieClip
   {
      [Embed(source="../uclient-ftr-battle-template/placeholder.json", mimeType="application/octet-stream")]
      private static const ManifestBytes:Class;
      include "UClientFtrFollowAtlasFactories.inc";

      private static const DIRECTIONS:Array = [
         "down", "leftdown", "left", "leftup",
         "up", "rightup", "right", "rightdown"
      ];

      private var _action:UClientFtrActionClip = new UClientFtrActionClip();
      private var _manifest:Object;
      private var _selectedDirection:String = "down";
      private var _awaitAction:String = "await";

      public function pet()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;

         var bytes:ByteArray = new ManifestBytes() as ByteArray;
         bytes.position = 0;
         _manifest = JSON.parse(bytes.readUTFBytes(bytes.length));
         _awaitAction = selectAwaitAction(_manifest);

         var pageCount:int = _manifest && _manifest.pages is Array ?
            _manifest.pages.length : 0;
         var pageFactories:Array = createAtlasFactories(pageCount);
         var pages:Array = new Array(pageFactories.length);

         var anchorOffsetY:Number = Number(_manifest && _manifest.anchorOffsetY || 0);
         if(isNaN(anchorOffsetY) || anchorOffsetY < -10000 || anchorOffsetY > 10000)
            anchorOffsetY = 0;
         _action.y = anchorOffsetY;
         addChild(_action);
         _action.install(_manifest,pages,pageFactories);
         _action.select(_awaitAction);

         // UClientFtrActionClip treats battle attacks as one-shot actions.
         // FollowPackage's official `await` is always a loop, so restart it at
         // its real terminal frame without altering authored frame cadence.
         addEventListener(Event.ENTER_FRAME,keepAwaitContinuous,false,0,true);
      }

      public function get uClientFollowReady():Boolean
      {
         return _action.ready;
      }

      public function get uClientFollowAction():String
      {
         return _awaitAction;
      }

      override public function get currentLabels():Array
      {
         return DIRECTIONS.map(function(name:String,index:int,all:Array):FrameLabel {
            return new FrameLabel(name,index + 1);
         });
      }

      override public function get currentLabel():String
      {
         return _selectedDirection;
      }

      override public function get currentFrameLabel():String
      {
         return _selectedDirection;
      }

      override public function gotoAndPlay(frame:Object,scene:String = null):void
      {
         selectDirection(frame);
      }

      override public function gotoAndStop(frame:Object,scene:String = null):void
      {
         // A legacy host commonly selects a direction with gotoAndStop().  The
         // child animation must still advance just like an ordinary timeline
         // MovieClip whose descendants keep playing on that labelled frame.
         selectDirection(frame);
      }

      override public function play():void
      {
         _action.gotoAndPlay(Math.max(1,_action.currentFrame));
      }

      override public function stop():void
      {
         // Keep the authored follow idle alive.  Stopping the outer direction
         // selector must not turn U-client follow models into a static pose.
      }

      private function selectDirection(value:Object):void
      {
         if(value is Number || value is int || value is uint)
         {
            var directionIndex:int = Math.max(0,Math.min(DIRECTIONS.length - 1,int(value) - 1));
            _selectedDirection = String(DIRECTIONS[directionIndex]);
         }
         var requested:String = String(value == null ? "" : value).toLowerCase();
         if(DIRECTIONS.indexOf(requested) >= 0)
            _selectedDirection = requested;
         // Direction changes select the outer legacy view only.  Re-selecting
         // the same label every host tick must not restart the official idle at
         // frame one and make it look static.
         if(_action.currentFrame >= _action.totalFrames)
            _action.select(_awaitAction);
      }

      private function selectAwaitAction(data:Object):String
      {
         var available:Object = {};
         if(data && data.sequences is Array)
         {
            for each(var sequence:Object in data.sequences)
            {
               var name:String = String(sequence && sequence.name || "").toLowerCase();
               if(name) available[name] = true;
            }
         }
         if(available.await) return "await";
         if(available.standby) return "standby";
         if(available.idle) return "idle";
         // Fail closed through the renderer's own standby/idle fallback.  This
         // value also makes a malformed FollowPackage visibly diagnosable.
         return "await";
      }

      private function keepAwaitContinuous(event:Event):void
      {
         if(_action.totalFrames > 1 && _action.currentFrame >= _action.totalFrames)
            _action.select(_awaitAction);
      }
   }
}
