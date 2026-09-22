package
{
   import flash.display.Bitmap;
   import flash.display.BitmapData;
   import flash.display.FrameLabel;
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.external.ExternalInterface;
   import flash.net.URLLoader;
   import flash.net.URLRequest;
   import flash.system.LoaderContext;

   /** Standard fight.swf facade shared by CoreDLL and FramePlayer. */
   public class pet extends MovieClip
   {
      private var _action:UClientFtrActionClip = new UClientFtrActionClip();
      private var _manifest:Object;
      private var _pages:Array = [];
      private var _labels:Array = ["idle","attack","sa","cp","hited"];
      private var _selected:String = "standby";
      private var _baseUrl:String = "";

      public function get uClientBattleReady():Boolean
      {
         return _manifest != null && _action.ready;
      }

      public function pet()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         addChild(_action);
         var url:String = loaderInfo && loaderInfo.url ? loaderInfo.url : "";
         var idMatch:Array = url.match(/\/(\d+)\.swf(?:[?#]|$)/);
         var originMatch:Array = url.match(/^(https?:\/\/[^\/]+)/i);
         var skinId:String = idMatch && idMatch.length > 1 ? idMatch[1] : "0";
         _baseUrl = (originMatch && originMatch.length > 1 ? originMatch[1] : "http://seer.61.com") +
            "/launcher/uclient-ftr-pet-battle/" + skinId + "/";
         if(skinId == "0")
         {
            return;
         }
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.addCallback("setUClientFtrBattleAction",selectActionForTest);
               ExternalInterface.addCallback("getUClientFtrBattleState",getBattleState);
            }
         }
         catch(error:*) {}
         loadManifest();
      }

      override public function get currentLabels():Array
      {
         return _labels.map(function(name:String, index:int, all:Array):FrameLabel {
            return new FrameLabel(name,index + 1);
         });
      }

      override public function get currentLabel():String
      {
         return _selected;
      }

      override public function get currentFrameLabel():String
      {
         return _selected;
      }

      override public function gotoAndStop(frame:Object, scene:String = null):void
      {
         selectAction(String(frame || "standby"));
      }

      override public function gotoAndPlay(frame:Object, scene:String = null):void
      {
         selectAction(String(frame || "standby"));
      }

      private function selectAction(value:String):void
      {
         var name:String = String(value || "").toLowerCase();
         if(name == "\u5f85\u673a" || name == "stand" || name == "wait") name = "standby";
         else if(name == "\u7269\u7406\u653b\u51fb" || name == "atk" || name == "attack1") name = "attack";
         else if(name == "\u7279\u6b8a\u653b\u51fb" || name == "special" || name == "magic") name = "sa";
         else if(name == "\u5c5e\u6027\u653b\u51fb" || name == "property" || name == "buff") name = "cp";
         else if(name == "\u88ab\u6253" || name == "hurt" || name == "hit" || name == "behit") name = "hited";
         else if(name == "\u5fc5\u6740" || name == "hidemove" || name == "ultimate") name = bestUltimate();
         if(name == "idle") name = "standby";
         _selected = name;
         _action.select(name);
      }

      private function selectActionForTest(value:String):Object
      {
         selectAction(value);
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
            ready:_manifest != null && _action.ready
         };
      }

      private function bestUltimate():String
      {
         for each(var name:String in _labels)
         {
            if(/^moves?[_-]?\d+/i.test(name) || /^(sa5|as5|attack5|hidemove|ultimate)/i.test(name)) return name;
         }
         return "attack";
      }

      private function loadManifest():void
      {
         var loader:URLLoader = new URLLoader();
         loader.addEventListener(Event.COMPLETE,function(event:Event):void {
            try
            {
               _manifest = JSON.parse(String(loader.data || "{}"));
               var names:Array = [];
               if(_manifest.sequences is Array)
               {
                  for each(var sequence:Object in _manifest.sequences)
                  {
                     var name:String = String(sequence.name || "").toLowerCase();
                     if(name && names.indexOf(name) < 0) names.push(name);
                  }
               }
               // Both battle players request the historical compact label
               // "idle" even though native UClientFtr manifests call it "standby".
               // Keep the alias visible so their normal label resolver chooses
               // this facade instead of falling through to another action.
               if(names.indexOf("standby") >= 0 && names.indexOf("idle") < 0) names.unshift("idle");
               _labels = names.length ? names : _labels;
               loadPages();
            }
            catch(error:*) {}
         });
         loader.addEventListener(IOErrorEvent.IO_ERROR,function(event:IOErrorEvent):void { report("manifest error " + event.text); });
         loader.load(new URLRequest(_baseUrl + "animation.json"));
      }

      private function loadPages():void
      {
         var definitions:Array = _manifest && _manifest.pages is Array ? _manifest.pages : [];
         if(!definitions.length) return;
         _pages = new Array(definitions.length);
         var remaining:int = definitions.length;
         for(var index:int = 0; index < definitions.length; index++)
         {
            (function(pageIndex:int, fileName:String):void {
               var loader:Loader = new Loader();
               var finish:Function = function():void {
               if(--remaining == 0)
               {
                  _action.install(_manifest,_pages);
                  dispatchEvent(new Event("uClientBattleReady"));
               }
               };
               loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(event:Event):void {
                  try
                  {
                     var bitmap:Bitmap = loader.content as Bitmap;
                     _pages[pageIndex] = bitmap && bitmap.bitmapData ? bitmap.bitmapData : null;
                  }
                  catch(error:*) {}
                  finish();
               });
               loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,function(event:IOErrorEvent):void { report("atlas error index=" + pageIndex + " " + event.text); finish(); });
               loader.load(new URLRequest(_baseUrl + fileName),new LoaderContext(true));
            })(index,String(definitions[index].file || ("atlas-" + index + ".png")));
         }
      }

      private function report(value:String):void
      {
         var line:String = "[UClientFtr_ADAPTER] " + value;
         trace(line);
         try { if(ExternalInterface.available) ExternalInterface.call("console.log",line); } catch(ignored:*) {}
      }
   }
}
