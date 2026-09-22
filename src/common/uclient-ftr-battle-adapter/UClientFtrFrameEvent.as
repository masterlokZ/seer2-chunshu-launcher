package
{
   import flash.events.Event;

   public final class UClientFtrFrameEvent extends Event
   {
      public static const EVENT_VIDEO:String = "uClientFtrEventVideo";

      public var actionName:String;
      public var sourceFrame:int;
      public var label:String;
      public var clip:String;
      public var actionEpoch:uint;

      public function UClientFtrFrameEvent(type:String, actionName:String,
         sourceFrame:int, label:String, clip:String, actionEpoch:uint)
      {
         super(type,false,false);
         this.actionName = actionName;
         this.sourceFrame = sourceFrame;
         this.label = label;
         this.clip = clip;
         this.actionEpoch = actionEpoch;
      }

      override public function clone():Event
      {
         return new UClientFtrFrameEvent(type,actionName,sourceFrame,label,clip,actionEpoch);
      }
   }
}
