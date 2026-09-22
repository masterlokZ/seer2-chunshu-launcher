package com.chunshu.seer2.uclient
{
   import flash.display.DisplayObject;
   import flash.display.DisplayObjectContainer;
   import flash.display.MovieClip;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.geom.Rectangle;
   import flash.utils.Dictionary;
   import flash.utils.getQualifiedClassName;
   import flash.utils.getTimer;

   /**
    * Shared UClient battle policy for CoreDLL, FramePlayer and game previews.
    *
    * This adapter intentionally never changes Stage quality.  Authored bitmap
    * resolution, vector quality and action duration belong to the resource.
    */
   [SWF(width="1", height="1", frameRate="40", backgroundColor="#000000")]
   public class UClientUniversalBattleAdapter extends Sprite
   {
      public static const VERSION:String = "1.3.0-clock-capability";
      public static const IDLE_SOURCE_FPS:Number = 15;
      public static const MAX_SIZE_MULTIPLIER:Number = 1.18;
      public static const TARGET_VISIBLE_WIDTH:Number = 480;
      public static const TARGET_VISIBLE_HEIGHT:Number = 400;

      private static const sessions:Dictionary = new Dictionary(true);

      private var pet:MovieClip;
      private var action:MovieClip;
      private var idleStartedAt:int;
      private var idleStartFrame:int = 1;
      private var lastLabel:String = "";
      private var disposed:Boolean = false;
      private var uClientResource:Boolean = false;

      public function UClientUniversalBattleAdapter(target:MovieClip = null)
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         if(target != null) bind(target);
      }

      public static function supports(target:MovieClip):Boolean
      {
         if(target == null) return false;
         try { return "uClientBattleReady" in target && Boolean(target["uClientBattleReady"]); }
         catch(ignored:*) {}
         return false;
      }

      public static function attach(target:MovieClip):UClientUniversalBattleAdapter
      {
         if(target == null) return null;
         // Native SWF pets must retain their authored ENTER_FRAME ordering.
         // Even a no-op listener changes the timing boundary between an idle
         // loop and a hurt transition, so fail closed before creating a
         // session for resources that do not explicitly expose UClient capability.
         if(!supports(target)) return null;
         var existing:UClientUniversalBattleAdapter = sessions[target] as UClientUniversalBattleAdapter;
         if(existing != null) return existing;
         var created:UClientUniversalBattleAdapter = new UClientUniversalBattleAdapter(target);
         sessions[target] = created;
         return created;
      }

      public static function detach(target:MovieClip):void
      {
         var existing:UClientUniversalBattleAdapter = target == null ? null : sessions[target] as UClientUniversalBattleAdapter;
         if(existing != null) existing.dispose();
      }

      public static function fitMultiplier(target:MovieClip,bounds:Rectangle):Number
      {
         if(!supports(target) || bounds == null || bounds.width <= 1 || bounds.height <= 1) return 1;
         var desired:Number = Math.min(TARGET_VISIBLE_WIDTH / bounds.width,TARGET_VISIBLE_HEIGHT / bounds.height);
         if(isNaN(desired) || desired <= 1) return 1;
         return Math.min(MAX_SIZE_MULTIPLIER,desired);
      }

      public function bind(target:MovieClip):void
      {
         if(disposed || target == null || pet === target) return;
         if(!supports(target)) return;
         unbindAction();
         pet = target;
         uClientResource = supports(target);
         // The nested action clip is replaced when a self-contained UClient pet
         // changes actions.  Keep the listener on the persistent pet root so
         // the 15-fps idle policy follows every newly created action clip.
         pet.addEventListener(Event.ENTER_FRAME,onPetFrame,false,-2000,true);
         if(uClientResource) refreshAction();
      }

      private function onPetFrame(event:Event):void
      {
         if(disposed || pet == null) return;
         if(uClientResource) refreshAction();
      }

      private function refreshAction():void
      {
         var next:MovieClip = findAction(pet,0);
         if(next === action) return;
         unbindAction();
         action = next;
         if(action != null)
         {
            // Self-contained renderers may own a real-time animation clock.
            // Re-seeking those clips from the shared idle clock redraws them
            // twice and resets their state. Legacy UClientActionClip resources do
            // not expose this capability and retain the existing 15 fps rule.
            if(!clockManaged(action) && !clockManaged(pet))
               action.addEventListener(Event.ENTER_FRAME,onActionFrame,false,-1000,false);
            resetIdleClock(action.currentFrame);
         }
      }

      private function clockManaged(target:Object):Boolean
      {
         if(target == null) return false;
         try
         {
            return "uClientBattleClockManaged" in target && Boolean(target["uClientBattleClockManaged"]);
         }
         catch(ignored:*) {}
         return false;
      }

      private function findAction(container:DisplayObjectContainer,depth:int):MovieClip
      {
         if(container == null || depth > 5) return null;
         var fallback:MovieClip = null;
         for(var index:int = 0; index < container.numChildren; index++)
         {
            var child:DisplayObject = container.getChildAt(index);
            var clip:MovieClip = child as MovieClip;
            if(clip != null)
            {
               var qualified:String = getQualifiedClassName(clip);
               if(qualified.indexOf("UClientActionClip") >= 0 || "ready" in clip && clip.totalFrames > 1) return clip;
               if(fallback == null && clip.totalFrames > 1) fallback = clip;
            }
            var nested:MovieClip = findAction(child as DisplayObjectContainer,depth + 1);
            if(nested != null) return nested;
         }
         return depth == 0 ? fallback : null;
      }

      private function isIdle():Boolean
      {
         if(pet == null) return false;
         var label:String = "";
         try { label = String(pet.currentLabel || pet.currentFrameLabel || "").toLowerCase(); }
         catch(ignored:*) {}
         return label == "standby" || label == "idle" || label == "stand" || label == "wait" || label == "\u5f85\u673a";
      }

      private function resetIdleClock(frame:int):void
      {
         idleStartedAt = getTimer();
         idleStartFrame = Math.max(1,frame);
      }

      private function onActionFrame(event:Event):void
      {
         if(disposed || pet == null || !uClientResource) return;
         if(clockManaged(action) || clockManaged(pet)) return;
         if(action == null || action.parent == null)
         {
            refreshAction();
            return;
         }
         var label:String = "";
         try { label = String(pet.currentLabel || pet.currentFrameLabel || "").toLowerCase(); }
         catch(ignored:*) {}
         if(label != lastLabel)
         {
            lastLabel = label;
            resetIdleClock(action.currentFrame);
         }
         if(!isIdle()) return;
         var total:int = Math.max(2,action.totalFrames);
         var elapsed:int = Math.max(0,getTimer() - idleStartedAt);
         var desired:int = 1 + ((idleStartFrame - 1 + int(elapsed * IDLE_SOURCE_FPS / 1000)) % total);
         if(action.currentFrame != desired)
         {
            try { action.gotoAndPlay(desired); }
            catch(playError:*)
            {
               try { action.gotoAndStop(desired); } catch(ignored:*) {}
            }
         }
      }

      private function unbindAction():void
      {
         if(action != null) action.removeEventListener(Event.ENTER_FRAME,onActionFrame);
         action = null;
      }

      public function dispose():void
      {
         if(disposed) return;
         disposed = true;
         unbindAction();
         if(pet != null)
         {
            pet.removeEventListener(Event.ENTER_FRAME,onPetFrame);
            delete sessions[pet];
         }
         pet = null;
      }
   }
}
