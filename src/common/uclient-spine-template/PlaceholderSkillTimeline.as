package
{
   import flash.display.Sprite;

   [SWF(width="1200",height="660",frameRate="30",backgroundColor="#000000")]
   public class PlaceholderSkillTimeline extends Sprite
   {
      private var _action:String = "";
      private var _elapsed:Number = 0;

      public function PlaceholderSkillTimeline()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
      }

      public function configureTimeline(value:Object):Boolean { return true; }
      public function selectTimelineAction(value:String):Boolean
      {
         _action = String(value || "").toLowerCase();
         _elapsed = 0;
         visible = false;
         return false;
      }
      public function seekTimelineSeconds(value:Number):Boolean
      {
         _elapsed = Math.max(0,Number(value) || 0);
         return false;
      }
      public function getTimelineState():Object
      {
         return { ready:true,active:false,action:_action,elapsed:_elapsed,placeholder:true };
      }
      public function disposeTimeline():void { visible = false; }
   }
}
