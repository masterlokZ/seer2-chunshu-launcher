package
{
   import flash.display.BitmapData;
   import flash.display.DisplayObject;
   import flash.display.DisplayObjectContainer;
   import flash.display.Graphics;
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.display.Shape;
   import flash.display.Sprite;
   import flash.display.StageAlign;
   import flash.display.StageScaleMode;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.external.ExternalInterface;
   import flash.geom.Matrix;
   import flash.geom.Rectangle;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;
   import flash.system.Security;
   import flash.utils.setTimeout;
   import flash.utils.getQualifiedClassName;
   
   [SWF(width="720", height="430", frameRate="30", backgroundColor="#07111D")]
   public class SkinPreviewPlayer extends Sprite
   {
      
      private var loader:Loader;
      
      private var model:MovieClip;
      
      private var actionTarget:MovieClip;
      
      private var uClientSpineClip:MovieClip;
      
      private var nestedActionClip:MovieClip;

      private var pendingActionSetup:Function;

      private var nestedPreviousFrame:int = 0;
      
      private var holder:Sprite;
      
      private var mode:String;
      
      private var callbackName:String = "skinPreviewState";
      
      private var initialAction:String = "idle";
      
      private var available:Array = [];
      
      private var background:Shape;
      
      private var actionStopFrame:int = 0;
      
      private var actionStartFrame:int = 0;
      
      private var actionElapsedFrames:int = 0;
      
      private var actionDurationFrames:int = 0;
      
      private var actionLoopLabel:String = "";
      
      private var actionUsesOuterTimeline:Boolean = false;
      
      private var actionBounds:Rectangle;
      
      private var battleIdleBounds:Rectangle;
      
      private var terminalFallbackAvailable:Boolean = false;
      
      private var terminalFallbackLabel:String = "";
      
      private var terminalSerial:int = 0;
      
      private var wideView:Boolean = false;
      
      private var baseViewWidth:Number = 0;
      
      private var baseViewHeight:Number = 0;
      
      private var currentActionKey:String = "idle";
      
      private var managedPlayback:Boolean = false;
      
      private var managedReady:Boolean = false;
      
      private var uClientBattleCamera:Boolean = false;
      
      private var fitRetrySerial:int = 0;
      
      private var cameraFitCount:int = 0;
      
      private var cameraFitRetryCount:int = 0;
      
      private var lastCameraBounds:Rectangle;
      
      public function SkinPreviewPlayer()
      {
         super();
         Security.allowDomain("*");
         Security.allowInsecureDomain("*");
         Security.loadPolicyFile("https://seer.61.com/crossdomain.xml");
         Security.loadPolicyFile("http://seer.61.com/crossdomain.xml");
         if(stage)
         {
            this.init();
         }
         else
         {
            addEventListener(Event.ADDED_TO_STAGE,this.onAdded);
         }
      }
      
      private function onAdded(param1:Event) : void
      {
         removeEventListener(Event.ADDED_TO_STAGE,this.onAdded);
         this.init();
      }
      
      private function init() : void
      {
         var source:String;
         stage.scaleMode = StageScaleMode.NO_SCALE;
         stage.align = StageAlign.TOP_LEFT;
         stage.addEventListener(Event.RESIZE,this.onResize,false,0,true);
         this.mode = String(loaderInfo.parameters.mode || "fight").toLowerCase();
         this.callbackName = String(loaderInfo.parameters.callback || "skinPreviewState");
         this.initialAction = String(loaderInfo.parameters.action || "idle").toLowerCase();
         this.wideView = String(loaderInfo.parameters.wide || "0") === "1";
         this.baseViewWidth = Number(loaderInfo.parameters.baseWidth || 0);
         this.baseViewHeight = Number(loaderInfo.parameters.baseHeight || 0);
         if(ExternalInterface.available)
         {
            try
            {
               ExternalInterface.addCallback("setWideView",this.setWideView);
               ExternalInterface.addCallback("getCameraState",this.getCameraState);
               ExternalInterface.addCallback("disposePreview",this.disposePreview);
            }
            catch(ignoredCallback:*)
            {
            }
         }
         this.drawBackground();
         this.holder = new Sprite();
         addChild(this.holder);
         source = String(loaderInfo.parameters.source || "");
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.addCallback("playAction",this.playAction);
               ExternalInterface.addCallback("getAvailableActions",function():Array
               {
                  return available.concat();
               });
            }
         }
         catch(ignored:*)
         {
         }
         if(!source)
         {
            this.notify("error",[],"缺少预览资源地址");
            return;
         }
         this.loader = new Loader();
         this.loader.contentLoaderInfo.addEventListener(Event.COMPLETE,this.onLoaded,false,0,true);
         this.loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR,this.onError,false,0,true);
         this.loader.load(new URLRequest(source),new LoaderContext(true,new ApplicationDomain(ApplicationDomain.currentDomain)));
      }
      
      private function drawBackground() : void
      {
         if(this.background == null)
         {
            this.background = new Shape();
            addChildAt(this.background,0);
         }
         var _loc1_:Number = stage == null ? 720 : Math.max(1,stage.stageWidth);
         var _loc2_:Number = stage == null ? 430 : Math.max(1,stage.stageHeight);
         var _loc3_:Graphics = this.background.graphics;
         _loc3_.clear();
         _loc3_.beginFill(463133,1);
         _loc3_.drawRect(0,0,_loc1_,_loc2_);
         _loc3_.endFill();
         if(this.mode === "thumbnail")
         {
            return;
         }
         _loc3_.lineStyle(1,1455691,1);
         var _loc4_:int = 0;
         while(_loc4_ <= _loc1_)
         {
            _loc3_.moveTo(_loc4_,0);
            _loc3_.lineTo(_loc4_,_loc2_);
            _loc4_ += 40;
         }
         var _loc5_:int = 0;
         while(_loc5_ <= _loc2_)
         {
            _loc3_.moveTo(0,_loc5_);
            _loc3_.lineTo(_loc1_,_loc5_);
            _loc5_ += 40;
         }
      }
      
      private function onResize(param1:Event) : void
      {
         this.drawBackground();
         this.fitModel();
      }
      
      private function onLoaded(param1:Event) : void
      {
         var loadedRoot:MovieClip = null;
         var skillClass:Class = null;
         var petClass:Class = null;
         var direction:String = null;
         var event:Event = param1;
         try
         {
            loadedRoot = this.loader.content as MovieClip;
            if((this.mode === "skill" || this.mode === "effect") && this.supportsManagedPlayback(loadedRoot))
            {
               this.model = loadedRoot;
            }
            else if((this.mode === "skill" || this.mode === "effect") && this.loader.contentLoaderInfo.applicationDomain.hasDefinition("skill"))
            {
               skillClass = this.loader.contentLoaderInfo.applicationDomain.getDefinition("skill") as Class;
               this.model = new skillClass() as MovieClip;
            }
            else if(this.loader.contentLoaderInfo.applicationDomain.hasDefinition("pet"))
            {
               petClass = this.loader.contentLoaderInfo.applicationDomain.getDefinition("pet") as Class;
               this.model = new petClass() as MovieClip;
            }
            else if(this.mode === "thumbnail")
            {
               this.model = this.loader.content as MovieClip;
               if(this.model == null)
               {
                  throw new Error("官方资源没有可显示的 MovieClip");
               }
               this.stopChildren(this.model);
               setTimeout(this.fitModel,120);
            }
            else
            {
               this.model = this.loader.content as MovieClip;
            }
            if(this.model == null)
            {
               throw new Error("官方资源没有可显示的 MovieClip");
            }
            this.managedPlayback = this.supportsManagedPlayback(this.model);
            this.managedReady = false;
            if(this.mode === "fight")
            {
               try
               {
                  if(this.model["setPreviewLooping"] is Function)
                  {
                     this.model["setPreviewLooping"](true);
                  }
               }
               catch(ignoredPreviewLoop:*)
               {
               }
            }
            if(this.managedPlayback)
            {
               this.model.addEventListener("uclientVideoReady",this.onManagedPlaybackReady,false,0,true);
               this.model.addEventListener("uclientVideoComplete",this.onManagedPlaybackComplete,false,0,true);
               this.model.addEventListener("uclientVideoError",this.onManagedPlaybackError,false,0,true);
               try
               {
                  this.model["setLooping"](true);
               }
               catch(loopError:*)
               {
               }
            }
            this.holder.addChild(this.model);
            if(this.mode === "fight")
            {
               try
               {
                  if(this.model["setUClientBattleBackdropHost"] is Function)
                  {
                     this.model["setUClientBattleBackdropHost"](this.holder,this.model);
                  }
               }
               catch(ignoredBackdropHost:*)
               {
               }
            }
            this.uClientBattleCamera = this.supportsUClientBattleCamera(this.model);
            this.uClientSpineClip = this.findUClientSpineClip(this.model);
            this.actionTarget = this.findActionTimeline(this.model);
            this.available = this.labelsOf(this.actionTarget);
            if(this.mode === "skill" || this.mode === "effect")
            {
               this.actionTarget = this.model;
               this.available = [this.mode === "effect" ? this.initialAction : "skill"];
               if(this.managedPlayback)
               {
                  try
                  {
                     this.actionBounds = this.model.getBounds(this.model);
                  }
                  catch(managedBoundsError:*)
                  {
                     actionBounds = null;
                  }
               }
               else
               {
                  this.startWholeClipLoop();
               }
               setTimeout(this.fitModel,120);
            }
            else if(this.mode === "fight")
            {
               this.battleIdleBounds = this.usableBounds(this.visualBounds());
               this.terminalFallbackAvailable = this.detectTerminalFallback();
               if(this.terminalFallbackAvailable && this.available.indexOf("__terminal__") < 0)
               {
                  this.available.push("__terminal__");
               }
               if(this.actionTarget != this.model && this.model.totalFrames > 1)
               {
                  this.model.gotoAndStop(1);
               }
               if(!this.playAction(this.initialAction))
               {
                  this.playAction("idle");
               }
               setTimeout(this.scheduleFitRetry,120);
            }
            else
            {
               direction = this.firstAvailable(["down","leftdown","left","leftup","up","rightup","right","rightdown"]);
               if(direction)
               {
                  this.model.gotoAndPlay(direction);
               }
               this.resumeChildren(this.model);
               if(this.mode === "thumbnail")
               {
                  setTimeout(this.freezeThumbnail,180);
               }
               setTimeout(this.fitModel,this.mode === "thumbnail" ? 200 : 120);
            }
            if(!this.managedPlayback)
            {
               this.notify("ready",this.available,"预览已加载");
            }
         }
         catch(error:*)
         {
            notify("error",[],String(error));
         }
      }
      
      public function playAction(param1:String) : Boolean
      {
         var actionKey:String;
         var label:String;
         var requested:String = param1;
         if(this.model == null || this.actionTarget == null)
         {
            return false;
         }
         actionKey = String(requested || "").toLowerCase();
         this.currentActionKey = actionKey || "idle";
         ++this.terminalSerial;
         if(this.mode === "skill" || this.mode === "effect")
         {
            this.stopActionMonitor();
            if(this.managedPlayback)
            {
               this.managedReady = false;
               try
               {
                  this.model["restartPlayback"]();
               }
               catch(restartError:*)
               {
                  notify("error",available,String(restartError));
                  return false;
               }
            }
            else
            {
               this.startWholeClipLoop();
            }
            this.notify("playing",this.available,this.mode === "effect" ? this.currentActionKey : "skill");
            return true;
         }
         label = this.resolveAction(requested);
         try
         {
            this.stopActionMonitor();
            this.actionBounds = null;
            if(actionKey === "idle")
            {
               this.playBattleIdle(label);
               this.notify("playing",this.available,"idle");
               return true;
            }
            if(!label && actionKey === "lowhp")
            {
               if(this.terminalFallbackLabel == "")
               {
                  this.terminalFallbackLabel = this.firstAvailable(["dying","lowhp","weak","dead","die"]);
               }
               if(this.terminalFallbackLabel == "")
               {
                  return false;
               }
               this.playTerminalFallback();
               this.notify("playing",this.available,"残血 / 被击败");
               return true;
            }
            if(!label)
            {
               if(actionKey === "ultimate")
               {
                  this.playBattleIdle("");
                  this.notify("error",this.available,"该模型未提供专属大招动作");
               }
               return false;
            }
            this.startLoopingAction(label);
            if(this.pendingActionSetup == null) this.resumeChildren(this.actionTarget);
            this.notify("playing",this.available,label);
            return true;
         }
         catch(error:*)
         {
            notify("error",available,String(error));
         }
         return false;
      }
      
      private function playBattleIdle(param1:String) : void
      {
         var serial:int = 0;
         var prepared:Boolean = false;
         var prepare:Function = null;
         var label:String = param1;
         this.stopActionMonitor();
         this.actionBounds = null;
         serial = this.terminalSerial;
         prepared = false;
         if(!label)
         {
            label = this.firstAvailable(["idle","stand","wait","attack","atk","attack1"]);
         }
         prepare = function(param1:Event = null):void
         {
            var event:Event = param1;
            if(prepared)
            {
               return;
            }
            if(serial != terminalSerial)
            {
               prepared = true;
               actionTarget.removeEventListener(Event.FRAME_CONSTRUCTED,prepare);
               return;
            }
            prepared = true;
            actionTarget.removeEventListener(Event.FRAME_CONSTRUCTED,prepare);
            setTimeout(function():void
            {
               var action:MovieClip;
               var visual:MovieClip = null;
               if(serial != terminalSerial)
               {
                  return;
               }
               action = firstDirectMovieChild(actionTarget);
               if(action != null)
               {
                  action.gotoAndStop(1);
                  visual = primaryActionVisual(action);
                  if(visual != null)
                  {
                     try
                     {
                        visual.gotoAndPlay(1);
                     }
                     catch(playError:*)
                     {
                        try
                        {
                           visual.play();
                        }
                        catch(ignored:*)
                        {
                        }
                     }
                  }
               }
               actionBounds = usableBounds(visualBounds());
               battleIdleBounds = actionBounds == null ? null : actionBounds.clone();
               scheduleFitRetry();
            },0);
         };
         this.actionTarget.addEventListener(Event.FRAME_CONSTRUCTED,prepare,false,int.MAX_VALUE,true);
         if(label)
         {
            this.actionTarget.gotoAndStop(label);
         }
         else
         {
            this.actionTarget.gotoAndStop(1);
         }
         setTimeout(prepare,50);
      }
      
      private function startLoopingAction(param1:String) : void
      {
         var label:String = param1;
         if(this.deferUClientActionUntilReady(label))
         {
            return;
         }
         this.actionLoopLabel = label;
         if(this.uClientSpineClip != null)
         {
            this.actionTarget.gotoAndPlay(label);
            this.actionStartFrame = 1;
            this.actionStopFrame = Math.max(2,this.uClientSpineClip.totalFrames);
            this.actionDurationFrames = this.actionStopFrame;
            this.actionUsesOuterTimeline = true;
            this.nestedActionClip = null;
         }
         else
         {
            this.actionStartFrame = this.frameForLabel(label);
            this.actionStopFrame = this.endFrameForLabel(label);
            var outerFrames:int = Math.max(1,this.actionStopFrame - this.actionStartFrame + 1);
            var serial:int = this.terminalSerial;
            var timeline:MovieClip = this.actionTarget;
            var prepared:Boolean = false;
            // gotoAndStop can leave the previous selector's children visible
            // until FRAME_CONSTRUCTED. Never bind that stale action instance.
            var configureNested:Function = function(event:Event = null):void
            {
               if(prepared) return;
               prepared = true;
               timeline.removeEventListener(Event.FRAME_CONSTRUCTED,configureNested);
               if(serial != terminalSerial || actionTarget !== timeline)
               {
                  return;
               }
               pendingActionSetup = null;
               var _loc1_:MovieClip = firstDirectMovieChild(actionTarget);
               var _loc2_:MovieClip = _loc1_ != null && _loc1_.totalFrames > 1 ? _loc1_ : longestAnimatedTimeline(actionTarget,0);
               var _loc3_:int = _loc2_ != null ? _loc2_.totalFrames : 1;
               if(_loc2_ != null && _loc3_ > 1)
               {
                  nestedActionClip = _loc2_;
                  actionDurationFrames = _loc3_;
                  actionUsesOuterTimeline = false;
                  actionTarget.stop();
               }
               else
               {
                  nestedActionClip = null;
                  actionDurationFrames = outerFrames;
                  actionUsesOuterTimeline = actionDurationFrames > 1;
               }
               restartLoopingAction();
            };
            this.pendingActionSetup = configureNested;
            timeline.addEventListener(Event.FRAME_CONSTRUCTED,configureNested,false,int.MAX_VALUE,true);
            timeline.gotoAndStop(label);
            // The same already-stopped selector may not construct another frame.
            setTimeout(configureNested,0);
         }
         this.actionBounds = this.stableBattleBounds();
         if(this.uClientSpineClip != null) this.restartLoopingAction();
         (this.uClientSpineClip == null ? this.actionTarget : this.uClientSpineClip).addEventListener(Event.ENTER_FRAME,this.onActionFrame,false,0,true);
         setTimeout(this.scheduleFitRetry,30);
      }
      
      private function findUClientSpineClip(param1:MovieClip) : MovieClip
      {
         var found:MovieClip = null;
         var root:MovieClip = param1;
         var visit:Function = function(param1:DisplayObjectContainer, param2:int):void
         {
            var _loc4_:DisplayObject = null;
            var _loc5_:MovieClip = null;
            var _loc6_:DisplayObjectContainer = null;
            if(found != null || param1 == null || param2 > 8)
            {
               return;
            }
            var _loc3_:int = 0;
            while(_loc3_ < param1.numChildren)
            {
               _loc4_ = param1.getChildAt(_loc3_);
               _loc5_ = _loc4_ as MovieClip;
               if(_loc5_ != null)
               {
                  try
                  {
                     if(Boolean(_loc5_["uClientBattleClockManaged"]))
                     {
                        found = _loc5_;
                        return;
                     }
                  }
                  catch(ignoredCapability:*)
                  {
                  }
               }
               _loc6_ = _loc4_ as DisplayObjectContainer;
               if(_loc6_ != null)
               {
                  visit(_loc6_,param2 + 1);
               }
               if(found != null)
               {
                  return;
               }
               _loc3_++;
            }
         };
         visit(root,0);
         return found;
      }
      
      private function uClientResourcesReady() : Boolean
      {
         var _loc1_:Object = null;
         var _loc2_:Object = null;
         if(this.uClientSpineClip == null || this.model == null)
         {
            return true;
         }
         try
         {
            if(this.model["uClientBattleReady"] === false)
            {
               return false;
            }
            if(this.model["getEmbeddedCinematicState"] is Function)
            {
               _loc1_ = this.model["getEmbeddedCinematicState"]();
               if(Boolean(_loc1_) && Boolean(_loc1_.enabled === true) && _loc1_.ready !== true)
               {
                  return false;
               }
            }
            if(this.model["getUClientSkillTimelineState"] is Function)
            {
               _loc2_ = this.model["getUClientSkillTimelineState"]();
               if(Boolean(_loc2_) && Boolean(_loc2_.enabled === true) && _loc2_.ready !== true)
               {
                  return false;
               }
            }
         }
         catch(ignoredReady:*)
         {
         }
         return true;
      }
      
      private function deferUClientActionUntilReady(param1:String) : Boolean
      {
         var serial:int = 0;
         var attempts:int = 0;
         var waitReady:Function = null;
         var label:String = param1;
         if(this.uClientSpineClip == null || this.uClientResourcesReady())
         {
            return false;
         }
         serial = this.terminalSerial;
         attempts = 0;
         waitReady = function():void
         {
            if(serial != terminalSerial || model == null || actionTarget == null)
            {
               return;
            }
            ++attempts;
            if(uClientResourcesReady() || attempts >= 40)
            {
               startLoopingAction(label);
            }
            else
            {
               setTimeout(waitReady,50);
            }
         };
         setTimeout(waitReady,50);
         return true;
      }
      
      private function startWholeClipLoop() : void
      {
         this.actionLoopLabel = "__whole__";
         this.actionStartFrame = 1;
         this.actionStopFrame = Math.max(1,this.actionTarget.totalFrames);
         this.actionDurationFrames = this.actionStopFrame;
         this.actionUsesOuterTimeline = this.actionStopFrame > 1;
         this.actionBounds = this.mode === "skill" || this.mode === "effect" ? this.measureActionBounds(1,this.actionStopFrame) : this.stableBattleBounds();
         this.restartLoopingAction();
         this.actionTarget.addEventListener(Event.ENTER_FRAME,this.onActionFrame,false,0,true);
      }
      
      private function measureActionBounds(param1:int, param2:int) : Rectangle
      {
         var _loc3_:Rectangle = null;
         var _loc4_:int = 0;
         var _loc5_:int = 0;
         var _loc6_:int = 0;
         var _loc7_:Rectangle = null;
         if(this.actionTarget == null || this.model == null)
         {
            return null;
         }
         try
         {
            _loc4_ = Math.max(1,param1);
            _loc5_ = Math.max(_loc4_,param2);
            _loc6_ = _loc4_;
            while(_loc6_ <= _loc5_)
            {
               this.actionTarget.gotoAndStop(_loc6_);
               _loc7_ = this.model.getBounds(this.model);
               if(!(_loc7_.width < 1 || _loc7_.height < 1))
               {
                  _loc3_ = _loc3_ == null ? _loc7_.clone() : _loc3_.union(_loc7_);
                  _loc3_ = this.sampleNestedMotionBounds(this.actionTarget,_loc3_,72);
               }
               _loc6_++;
            }
         }
         catch(ignored:*)
         {
         }
         return _loc3_;
      }
      
      private function restartLoopingAction() : void
      {
         var _loc1_:MovieClip = null;
         var _loc2_:MovieClip = null;
         this.actionElapsedFrames = 0;
         this.nestedPreviousFrame = 0;
         if(this.uClientSpineClip != null)
         {
            this.actionTarget.gotoAndPlay(this.actionLoopLabel);
            this.actionStartFrame = 1;
            this.actionStopFrame = Math.max(2,this.uClientSpineClip.totalFrames);
            this.actionDurationFrames = this.actionStopFrame;
         }
         else if(this.actionUsesOuterTimeline)
         {
            if(this.actionLoopLabel === "__whole__")
            {
               this.actionTarget.gotoAndPlay(1);
            }
            else
            {
               this.actionTarget.gotoAndPlay(this.actionLoopLabel);
            }
            this.resumeChildren(this.actionTarget);
         }
         else if(this.nestedActionClip != null)
         {
            if(this.actionTarget != null && this.actionStartFrame > 0 && this.actionTarget.currentFrame != this.actionStartFrame)
            {
               this.actionTarget.gotoAndStop(this.actionStartFrame);
            }
            _loc1_ = this.firstDirectMovieChild(this.actionTarget);
            _loc2_ = _loc1_ != null && _loc1_.totalFrames > 1 ? _loc1_ : this.longestAnimatedTimeline(this.actionTarget,0);
            if(_loc2_ != null && _loc2_.totalFrames > 1)
            {
               this.nestedActionClip = _loc2_;
            }
            if(this.nestedActionClip != null)
            {
               this.nestedActionClip.gotoAndPlay(1);
               this.resumeChildren(this.nestedActionClip);
            }
         }
         else
         {
            if(Boolean(this.actionLoopLabel) && this.actionLoopLabel !== "__whole__")
            {
               this.actionTarget.gotoAndStop(this.actionLoopLabel);
            }
            else
            {
               this.actionTarget.gotoAndStop(1);
            }
            this.actionDurationFrames = Math.max(2,this.maxDescendantFrames(this.actionTarget));
            this.resumeChildren(this.actionTarget);
         }
      }
      
      private function supportsManagedPlayback(param1:MovieClip) : Boolean
      {
         if(param1 == null)
         {
            return false;
         }
         try
         {
            return param1["setLooping"] is Function && param1["restartPlayback"] is Function && param1["disposePlayback"] is Function;
         }
         catch(ignored:*)
         {
         }
         return false;
      }
      
      private function supportsUClientBattleCamera(param1:MovieClip) : Boolean
      {
         if(param1 == null || this.mode !== "fight")
         {
            return false;
         }
         return this.containsUClientBattleCapability(param1,0);
      }
      
      private function containsUClientBattleCapability(param1:DisplayObject, param2:int) : Boolean
      {
         var _loc4_:int = 0;
         if(param1 == null || param2 > 8)
         {
            return false;
         }
         try
         {
            if(Boolean(param1["uClientBattleClockManaged"]) || Boolean(param1["uClientBattleReady"]))
            {
               return true;
            }
         }
         catch(ignored:*)
         {
         }
         var _loc3_:DisplayObjectContainer = param1 as DisplayObjectContainer;
         if(_loc3_ != null)
         {
            _loc4_ = 0;
            while(_loc4_ < _loc3_.numChildren)
            {
               if(this.containsUClientBattleCapability(_loc3_.getChildAt(_loc4_),param2 + 1))
               {
                  return true;
               }
               _loc4_++;
            }
         }
         return false;
      }
      
      private function onManagedPlaybackReady(param1:Event) : void
      {
         var event:Event = param1;
         if(event.currentTarget !== this.model || this.managedReady)
         {
            return;
         }
         this.managedReady = true;
         try
         {
            this.actionBounds = this.model.getBounds(this.model);
         }
         catch(ignoredBounds:*)
         {
            actionBounds = null;
         }
         this.fitModel();
         this.notify("ready",this.available,"视频首帧已解码");
      }
      
      private function onManagedPlaybackComplete(param1:Event) : void
      {
         if(param1.currentTarget !== this.model)
         {
            return;
         }
         this.managedReady = false;
         this.notify("complete",this.available,"视频本轮播放完成");
      }
      
      private function onManagedPlaybackError(param1:Event) : void
      {
         var _loc3_:Object = null;
         if(param1.currentTarget !== this.model)
         {
            return;
         }
         var _loc2_:String = "视频解码失败";
         try
         {
            _loc3_ = this.model["getPlaybackState"]();
            if(Boolean(_loc3_) && Boolean(_loc3_.error))
            {
               _loc2_ += "：" + String(_loc3_.error);
            }
         }
         catch(ignoredState:*)
         {
         }
         this.notify("error",this.available,_loc2_);
      }
      
      private function frameForLabel(param1:String) : int
      {
         var _loc2_:* = undefined;
         for each(_loc2_ in this.actionTarget.currentLabels)
         {
            if(String(_loc2_.name).toLowerCase() === param1.toLowerCase())
            {
               return int(_loc2_.frame);
            }
         }
         return 1;
      }
      
      private function endFrameForLabel(param1:String) : int
      {
         var _loc2_:Array = this.actionTarget.currentLabels;
         var _loc3_:int = 0;
         while(_loc3_ < _loc2_.length)
         {
            if(String(_loc2_[_loc3_].name).toLowerCase() === param1.toLowerCase())
            {
               return _loc3_ + 1 < _loc2_.length ? int(Math.max(int(_loc2_[_loc3_].frame),int(_loc2_[_loc3_ + 1].frame) - 1)) : this.actionTarget.totalFrames;
            }
            _loc3_++;
         }
         return this.actionTarget.totalFrames;
      }
      
      private function onActionFrame(param1:Event) : void
      {
         if(this.pendingActionSetup != null) return;
         var _loc3_:MovieClip = null;
         ++this.actionElapsedFrames;
         this.observeActionBounds();
         var _loc2_:Boolean = false;
         if(this.uClientSpineClip != null)
         {
            if(this.currentActionKey === "hurt" || this.actionLoopLabel === "hited")
            {
               _loc2_ = this.uClientSpineClip.currentFrame >= this.actionStopFrame;
            }
            else
            {
               _loc2_ = this.uClientSpineClip.currentFrame >= this.actionStopFrame;
            }
         }
         else if(this.nestedActionClip != null)
         {
            if(this.actionTarget != null && this.actionStartFrame > 0 && this.actionTarget.currentFrame != this.actionStartFrame)
            {
               this.actionTarget.gotoAndStop(this.actionStartFrame);
            }
            if(this.nestedActionClip.currentFrame == 1 && this.nestedActionClip.totalFrames > 1 && this.actionElapsedFrames > 1)
            {
               this.nestedActionClip.gotoAndPlay(2);
               this.resumeChildren(this.nestedActionClip);
            }
            // Give the last child frame a full display tick before restarting.
            _loc2_ = this.nestedPreviousFrame >= this.nestedActionClip.totalFrames;
            this.nestedPreviousFrame = this.nestedActionClip.currentFrame;
         }
         else if(this.actionUsesOuterTimeline)
         {
            // Some exported pet classes construct their action one frame later
            // than the selector event. Promote that real child before a short
            // outer span can reset it, and hold the selector from then on.
            _loc3_ = this.firstDirectMovieChild(this.actionTarget);
            if(this.actionLoopLabel !== "__whole__" && _loc3_ != null && _loc3_.totalFrames > 1)
            {
               this.actionTarget.gotoAndStop(this.actionStartFrame);
               this.nestedActionClip = _loc3_;
               this.actionDurationFrames = _loc3_.totalFrames;
               this.actionUsesOuterTimeline = false;
               this.restartLoopingAction();
            }
            else _loc2_ = this.actionTarget.currentFrame >= this.actionStopFrame;
         }
         else
         {
            _loc3_ = this.longestAnimatedTimeline(this.actionTarget,0);
            if(_loc3_ != null && _loc3_.totalFrames > 1)
            {
               this.nestedActionClip = _loc3_;
               this.actionDurationFrames = _loc3_.totalFrames;
               this.actionUsesOuterTimeline = false;
               this.nestedActionClip.gotoAndPlay(this.nestedActionClip.totalFrames > 1 ? 2 : 1);
               this.resumeChildren(this.nestedActionClip);
            }
            _loc2_ = this.actionElapsedFrames >= this.actionDurationFrames;
         }
         if(Boolean(this.actionTarget != null) && Boolean(this.actionLoopLabel) && _loc2_)
         {
            this.restartLoopingAction();
         }
      }
      
      private function observeActionBounds() : void
      {
         var _loc1_:Rectangle = null;
         if(this.mode !== "skill" || this.model == null)
         {
            return;
         }
         try
         {
            _loc1_ = this.model.getBounds(this.model);
            if(_loc1_.width > 0 && _loc1_.height > 0)
            {
               this.model.x = -(_loc1_.x + _loc1_.width / 2);
               this.model.y = -(_loc1_.y + _loc1_.height / 2);
            }
         }
         catch(ignored:*)
         {
         }
      }
      
      private function sampleNestedMotionBounds(param1:DisplayObjectContainer, param2:Rectangle, param3:int) : Rectangle
      {
         var _loc7_:int = 0;
         var _loc8_:Rectangle = null;
         var _loc4_:MovieClip = this.longestAnimatedTimeline(param1,0);
         if(_loc4_ == null || _loc4_.totalFrames <= 1 || this.model == null)
         {
            return param2;
         }
         var _loc5_:int = _loc4_.currentFrame;
         var _loc6_:int = Math.max(1,Math.ceil(_loc4_.totalFrames / Math.max(1,param3)));
         try
         {
            _loc7_ = 1;
            while(_loc7_ <= _loc4_.totalFrames)
            {
               _loc4_.gotoAndStop(_loc7_);
               _loc8_ = this.model.getBounds(this.model);
               if(_loc8_.width > 0 && _loc8_.height > 0)
               {
                  param2 = param2 == null ? _loc8_.clone() : param2.union(_loc8_);
               }
               _loc7_ += _loc6_;
            }
            if((_loc4_.totalFrames - 1) % _loc6_ != 0)
            {
               _loc4_.gotoAndStop(_loc4_.totalFrames);
               _loc8_ = this.model.getBounds(this.model);
               if(_loc8_.width > 0 && _loc8_.height > 0)
               {
                  param2 = param2 == null ? _loc8_.clone() : param2.union(_loc8_);
               }
            }
         }
         catch(ignored:*)
         {
         }
         try
         {
            _loc4_.gotoAndStop(_loc5_);
         }
         catch(restoreError:*)
         {
         }
         return param2;
      }
      
      private function longestAnimatedTimeline(param1:DisplayObjectContainer, param2:int) : MovieClip
      {
         var _loc3_:MovieClip = null;
         var _loc5_:DisplayObject = null;
         var _loc6_:MovieClip = null;
         var _loc7_:DisplayObjectContainer = null;
         var _loc8_:MovieClip = null;
         if(param1 == null || param2 > 7)
         {
            return null;
         }
         var _loc4_:int = 0;
         while(_loc4_ < param1.numChildren)
         {
            _loc5_ = param1.getChildAt(_loc4_);
            _loc6_ = _loc5_ as MovieClip;
            if(_loc6_ != null && _loc6_.totalFrames > 1 && (_loc3_ == null || _loc6_.totalFrames > _loc3_.totalFrames))
            {
               _loc3_ = _loc6_;
            }
            _loc7_ = _loc5_ as DisplayObjectContainer;
            _loc8_ = _loc7_ == null ? null : this.longestAnimatedTimeline(_loc7_,param2 + 1);
            if(_loc8_ != null && (_loc3_ == null || _loc8_.totalFrames > _loc3_.totalFrames))
            {
               _loc3_ = _loc8_;
            }
            _loc4_++;
         }
         return _loc3_;
      }
      
      private function detectTerminalFallback() : Boolean
      {
         if(this.actionTarget == null)
         {
            return false;
         }
         if(this.firstAvailable(["dying","lowhp","weak","lose","lost","failure","fail","defeat","dead","death"]) != "")
         {
            return false;
         }
         this.terminalFallbackLabel = this.firstAvailable(["hited","hurt","hit","beHit","damage"]);
         return this.terminalFallbackLabel != "";
      }
      
      private function playTerminalFallback() : void
      {
         var serial:int = 0;
         var prepared:Boolean = false;
         var prepare:Function = null;
         this.stopActionMonitor();
         this.actionBounds = null;
         serial = this.terminalSerial;
         prepared = false;
         prepare = function(param1:Event = null):void
         {
            var event:Event = param1;
            if(prepared)
            {
               return;
            }
            if(serial != terminalSerial)
            {
               prepared = true;
               actionTarget.removeEventListener(Event.FRAME_CONSTRUCTED,prepare);
               return;
            }
            prepared = true;
            actionTarget.removeEventListener(Event.FRAME_CONSTRUCTED,prepare);
            setTimeout(function():void
            {
               var terminal:MovieClip = null;
               if(serial != terminalSerial)
               {
                  return;
               }
               terminal = firstDirectMovieChild(actionTarget);
               if(terminal != null)
               {
                  terminal.gotoAndStop(terminal.totalFrames);
                  setTimeout(function():void
                  {
                     if(serial != terminalSerial)
                     {
                        return;
                     }
                     if(hasAnimatedDescendant(terminal,0))
                     {
                        resumeChildren(terminal);
                     }
                     actionBounds = usableBounds(visualBounds());
                     scheduleFitRetry();
                  },200);
               }
               else
               {
                  actionBounds = usableBounds(visualBounds());
                  scheduleFitRetry();
               }
            },0);
         };
         this.actionTarget.addEventListener(Event.FRAME_CONSTRUCTED,prepare,false,int.MAX_VALUE,true);
         this.actionTarget.gotoAndStop(this.terminalFallbackLabel);
         setTimeout(prepare,50);
      }
      
      private function firstDirectMovieChild(param1:DisplayObjectContainer) : MovieClip
      {
         var _loc3_:MovieClip = null;
         if(param1 == null)
         {
            return null;
         }
         var _loc2_:int = 0;
         while(_loc2_ < param1.numChildren)
         {
            _loc3_ = param1.getChildAt(_loc2_) as MovieClip;
            if(_loc3_ != null)
            {
               return _loc3_;
            }
            _loc2_++;
         }
         return null;
      }
      
      private function primaryActionVisual(param1:MovieClip) : MovieClip
      {
         var _loc3_:MovieClip = null;
         var _loc2_:MovieClip = this.firstDirectMovieChild(param1);
         var _loc4_:int = 0;
         while(_loc2_ != null && _loc2_.totalFrames <= 1 && _loc4_ < 4)
         {
            _loc3_ = this.firstDirectMovieChild(_loc2_);
            if(_loc3_ == null)
            {
               break;
            }
            _loc2_ = _loc3_;
            _loc4_++;
         }
         return _loc2_ != null && _loc2_.totalFrames > 1 ? _loc2_ : null;
      }
      
      private function firstAnimatedChild(param1:DisplayObjectContainer) : MovieClip
      {
         var _loc3_:MovieClip = null;
         if(param1 == null)
         {
            return null;
         }
         var _loc2_:int = 0;
         while(_loc2_ < param1.numChildren)
         {
            _loc3_ = param1.getChildAt(_loc2_) as MovieClip;
            if(_loc3_ != null && _loc3_.totalFrames > 1)
            {
               return _loc3_;
            }
            _loc2_++;
         }
         return this.longestAnimatedTimeline(param1,0);
      }
      
      private function hasAnimatedDescendant(param1:DisplayObjectContainer, param2:int) : Boolean
      {
         var _loc4_:DisplayObject = null;
         var _loc5_:MovieClip = null;
         var _loc6_:DisplayObjectContainer = null;
         if(param1 == null || param2 > 8)
         {
            return false;
         }
         var _loc3_:int = 0;
         while(_loc3_ < param1.numChildren)
         {
            _loc4_ = param1.getChildAt(_loc3_);
            _loc5_ = _loc4_ as MovieClip;
            if(_loc5_ != null && _loc5_.totalFrames > 1)
            {
               return true;
            }
            _loc6_ = _loc4_ as DisplayObjectContainer;
            if(_loc6_ != null && this.hasAnimatedDescendant(_loc6_,param2 + 1))
            {
               return true;
            }
            _loc3_++;
         }
         return false;
      }
      
      private function stopActionMonitor() : void
      {
         if(this.actionTarget != null)
         {
            this.actionTarget.removeEventListener(Event.ENTER_FRAME,this.onActionFrame);
            if(this.pendingActionSetup != null)
               this.actionTarget.removeEventListener(Event.FRAME_CONSTRUCTED,this.pendingActionSetup);
         }
         this.pendingActionSetup = null;
         this.nestedPreviousFrame = 0;
         if(this.uClientSpineClip != null)
         {
            this.uClientSpineClip.removeEventListener(Event.ENTER_FRAME,this.onActionFrame);
         }
         this.nestedActionClip = null;
         this.actionStopFrame = 0;
         this.actionStartFrame = 0;
         this.actionElapsedFrames = 0;
         this.actionDurationFrames = 0;
         this.actionLoopLabel = "";
         this.actionUsesOuterTimeline = false;
      }
      
      private function maxDescendantFrames(param1:DisplayObjectContainer) : int
      {
         var _loc4_:DisplayObject = null;
         var _loc5_:MovieClip = null;
         var _loc6_:DisplayObjectContainer = null;
         var _loc2_:int = 1;
         if(param1 == null)
         {
            return _loc2_;
         }
         var _loc3_:int = 0;
         while(_loc3_ < param1.numChildren)
         {
            _loc4_ = param1.getChildAt(_loc3_);
            _loc5_ = _loc4_ as MovieClip;
            if(_loc5_ != null)
            {
               _loc2_ = Math.max(_loc2_,_loc5_.totalFrames);
            }
            _loc6_ = _loc4_ as DisplayObjectContainer;
            if(_loc6_ != null)
            {
               _loc2_ = Math.max(_loc2_,this.maxDescendantFrames(_loc6_));
            }
            _loc3_++;
         }
         return _loc2_;
      }
      
      private function resolveAction(param1:String) : String
      {
         var _loc8_:Array = null;
         var _loc9_:String = null;
         var _loc2_:String = String(param1 || "").toLowerCase();
         var _loc3_:Boolean = this.firstAvailable(["attack","atk","physical"]) != "";
         var _loc4_:Array = _loc3_ ? ["sa5","as5","attack5","attack1","hidemove","ultimate","ultra","power","add1"] : ["sa5","as5","attack5","hidemove","ultimate","ultra","power","add1"];
         var _loc5_:Object = {
            "idle":["idle","stand","wait","attack","atk","attack1"],
            "physical":(_loc3_ ? ["attack","atk","physical","attack1","at1"] : ["attack1","at1","attack","atk","physical"]),
            "special":["sa","special","magic","attack2","at2","add2"],
            "property":["cp","property","buff","effect","add3"],
            "ultimate":_loc4_,
            "appear":["appear","entrance","show","present","intro","debut","出场","入场"],
            "transform":["transform","trans","change","morph","miracle"],
            "hurt":["hited","hurt","hit"],
            "lowhp":["dying","weak","dead","die"]
         };
         var _loc6_:Array = _loc5_[_loc2_] as Array;
         if(_loc6_ == null)
         {
            _loc6_ = [_loc2_];
         }
         var _loc7_:String = this.firstAvailable(_loc6_);
         if(!_loc7_ && _loc2_ === "ultimate")
         {
            // Authored action-family fingerprint: the first-frame move aliases
            // physical attack; its paired later selector owns the cinematic.
            // No resource/skin identity or fixed animation length is involved.
            var firstMove:String = this.firstAvailable(["moves_37520"]);
            var cinematicMove:String = this.firstAvailable(["moves_37521"]);
            if(firstMove && cinematicMove && this.frameForLabel(firstMove) == 1 && this.frameForLabel(cinematicMove) > 1)
               return cinematicMove;
            _loc8_ = [];
            for each(_loc9_ in this.available)
            {
               if(/^moves?_?\d+(?:_\d+)?$/i.test(_loc9_) || /^add\d+$/i.test(_loc9_) || /^attack\d+$/i.test(_loc9_) && _loc9_ != "attack" && _loc9_ != "atk")
               {
                  _loc8_.push(_loc9_);
               }
            }
            if(_loc8_.length == 1)
            {
               return String(_loc8_[0]);
            }
            if(_loc8_.length > 1)
            {
               return this.pickBestUltimateMove(_loc8_);
            }
         }
         return _loc7_;
      }
      
      private function pickBestUltimateMove(param1:Array) : String
      {
         var _loc11_:String = null;
         var _loc14_:Object = null;
         var _loc15_:Object = null;
         var _loc16_:Boolean = false;
         var _loc17_:int = 0;
         var _loc18_:int = 0;
         if(param1 == null || param1.length == 0)
         {
            return "";
         }
         if(this.actionTarget == null)
         {
            return String(param1[0]);
         }
         var _loc2_:String = this.firstAvailable(["attack","atk","attack1","at1","physical"]);
         var _loc3_:String = this.firstAvailable(["sa","special","magic","attack2","at2"]);
         var _loc4_:String = this.firstAvailable(["cp","property","buff","effect"]);
         var _loc5_:int = this.actionTarget.currentFrame;
         var _loc6_:Object = this.getActionLabelStats(_loc2_);
         var _loc7_:Object = this.getActionLabelStats(_loc3_);
         var _loc8_:Object = this.getActionLabelStats(_loc4_);
         var _loc9_:Array = [];
         var _loc10_:Array = [];
         for each(_loc11_ in param1)
         {
            _loc15_ = this.getActionLabelStats(_loc11_);
            if(_loc15_ != null)
            {
               _loc15_.label = _loc11_;
               _loc10_.push(_loc15_);
               _loc16_ = false;
               if(_loc6_ != null && this.isDuplicateActionStats(_loc15_,_loc6_))
               {
                  _loc16_ = true;
               }
               if(_loc7_ != null && this.isDuplicateActionStats(_loc15_,_loc7_))
               {
                  _loc16_ = true;
               }
               if(_loc8_ != null && this.isDuplicateActionStats(_loc15_,_loc8_))
               {
                  _loc16_ = true;
               }
               if(!_loc16_)
               {
                  _loc9_.push(_loc15_);
               }
            }
         }
         try
         {
            this.actionTarget.gotoAndStop(_loc5_);
         }
         catch(ignored:*)
         {
         }
         var _loc12_:Array = _loc9_.length > 0 ? _loc9_ : _loc10_;
         if(_loc12_.length == 0)
         {
            return String(param1[0]);
         }
         var _loc13_:Object = _loc12_[0];
         for each(_loc14_ in _loc12_)
         {
            _loc17_ = this.scoreMoveCandidate(String(_loc13_.label),int(_loc13_.totalFrames));
            _loc18_ = this.scoreMoveCandidate(String(_loc14_.label),int(_loc14_.totalFrames));
            if(_loc18_ > _loc17_)
            {
               _loc13_ = _loc14_;
            }
         }
         return String(_loc13_.label);
      }
      
      private function scoreMoveCandidate(param1:String, param2:int) : int
      {
         var _loc3_:Array = param1.match(/moves?_?(\d+)/i);
         var _loc4_:int = _loc3_ != null && _loc3_.length > 1 ? int(_loc3_[1]) : 0;
         var _loc5_:Boolean = _loc4_ == 0 || _loc4_ >= 30000;
         return (_loc5_ ? 1000000 : 0) + param2;
      }
      
      private function getActionLabelStats(param1:String) : Object
      {
         var f:int;
         var child:MovieClip;
         var dur:int;
         var childFrames:int;
         var descFrames:int;
         var maxF:int;
         var label:String = param1;
         if(!label || this.actionTarget == null)
         {
            return null;
         }
         f = this.frameForLabel(label);
         if(f <= 0)
         {
            return null;
         }
         try
         {
            this.actionTarget.gotoAndStop(f);
         }
         catch(e:*)
         {
            return null;
         }
         child = this.firstDirectMovieChild(this.actionTarget);
         dur = this.endFrameForLabel(label) - f + 1;
         childFrames = child != null ? int(child.totalFrames) : 1;
         descFrames = child != null ? this.maxDescendantFrames(child) : 1;
         maxF = Math.max(dur,childFrames,descFrames);
         return {
            "frame":f,
            "child":child,
            "totalFrames":maxF
         };
      }
      
      private function isDuplicateActionStats(param1:Object, param2:Object) : Boolean
      {
         if(param1 == null || param2 == null)
         {
            return false;
         }
         if(param1.child != null && param2.child != null)
         {
            if(param1.child === param2.child)
            {
               return true;
            }
            // Equal duration does not identify an animation. Only an actual
            // shared instance or a concrete exported symbol class is evidence.
            var symbolA:String = getQualifiedClassName(param1.child);
            var symbolB:String = getQualifiedClassName(param2.child);
            if(symbolA == symbolB && symbolA != "flash.display::MovieClip" && param1.child.constructor === param2.child.constructor)
            {
               return true;
            }
         }
         return false;
      }
      
      private function firstAvailable(param1:Array) : String
      {
         var _loc2_:String = null;
         var _loc3_:String = null;
         for each(_loc2_ in param1)
         {
            for each(_loc3_ in this.available)
            {
               if(_loc3_.toLowerCase() === _loc2_.toLowerCase())
               {
                  return _loc3_;
               }
            }
         }
         return "";
      }
      
      private function isHurtActionDistinct(param1:MovieClip, param2:int, param3:String) : Boolean
      {
         var currentF:int;
         var dur:int;
         var labels:Array;
         var i:int;
         var hurtChild:MovieClip;
         var childFrames:int;
         var descFrames:int;
         var maxHurtF:int;
         var stopF:int = 0;
         var clip:MovieClip = param1;
         var frame:int = param2;
         var label:String = param3;
         if(clip == null || frame <= 0)
         {
            return false;
         }
         currentF = clip.currentFrame;
         dur = 1;
         labels = clip.currentLabels;
         i = 0;
         while(i < labels.length)
         {
            if(String(labels[i].name).toLowerCase() === label.toLowerCase())
            {
               stopF = i + 1 < labels.length ? int(Math.max(int(labels[i].frame),int(labels[i + 1].frame) - 1)) : clip.totalFrames;
               dur = Math.max(1,stopF - frame + 1);
               break;
            }
            i++;
         }
         try
         {
            clip.gotoAndStop(frame);
         }
         catch(e:*)
         {
            return false;
         }
         hurtChild = this.firstDirectMovieChild(clip);
         childFrames = hurtChild != null ? int(hurtChild.totalFrames) : 1;
         descFrames = hurtChild != null ? this.maxDescendantFrames(hurtChild) : 1;
         maxHurtF = Math.max(dur,childFrames,descFrames);
         if(maxHurtF <= 1)
         {
            try
            {
               clip.gotoAndStop(currentF);
            }
            catch(ignored1:*)
            {
            }
            return false;
         }
         try
         {
            clip.gotoAndStop(currentF);
         }
         catch(ignored2:*)
         {
         }
         return true;
      }
      
      private function labelsOf(param1:MovieClip) : Array
      {
         var _loc3_:* = undefined;
         var _loc4_:String = null;
         var _loc5_:String = null;
         var _loc2_:Array = [];
         if(param1 == null)
         {
            return _loc2_;
         }
         for each(_loc3_ in param1.currentLabels)
         {
            _loc4_ = String(_loc3_.name);
            _loc5_ = _loc4_.toLowerCase();
            if(_loc5_ == "hited" || _loc5_ == "hurt" || _loc5_ == "hit")
            {
               if(!this.isHurtActionDistinct(param1,int(_loc3_.frame),_loc4_))
               {
                  continue;
               }
            }
            _loc2_.push(_loc4_);
         }
         return _loc2_;
      }
      
      private function findActionTimeline(param1:MovieClip) : MovieClip
      {
         var best:MovieClip = null;
         var bestScore:int = 0;
         var visited:int = 0;
         var root:MovieClip = param1;
         var visit:Function = function(param1:DisplayObjectContainer, param2:int):void
         {
            var _loc4_:DisplayObject = null;
            var _loc5_:MovieClip = null;
            var _loc6_:DisplayObjectContainer = null;
            var _loc7_:int = 0;
            if(param1 == null || param2 > 8 || visited > 800)
            {
               return;
            }
            var _loc3_:int = 0;
            while(_loc3_ < param1.numChildren)
            {
               _loc4_ = param1.getChildAt(_loc3_);
               ++visited;
               _loc5_ = _loc4_ as MovieClip;
               if(_loc5_ != null)
               {
                  _loc7_ = actionScore(_loc5_);
                  if(_loc7_ > bestScore || _loc7_ == bestScore && _loc7_ > 0 && _loc5_.currentLabels.length > best.currentLabels.length)
                  {
                     best = _loc5_;
                     bestScore = _loc7_;
                  }
               }
               _loc6_ = _loc4_ as DisplayObjectContainer;
               if(_loc6_ != null)
               {
                  visit(_loc6_,param2 + 1);
               }
               _loc3_++;
            }
         };
         best = root;
         bestScore = this.actionScore(root);
         visited = 0;
         visit(root,0);
         return best;
      }
      
      private function actionScore(param1:MovieClip) : int
      {
         var _loc4_:* = undefined;
         var _loc5_:String = null;
         if(param1 == null)
         {
            return 0;
         }
         var _loc2_:Array = ["idle","stand","wait","normal","attack","atk","attack1","at1","physical","sa","special","magic","attack2","at2","cp","property","buff","effect","sa5","as5","attack5","hidemove","ultimate","hited","hurt","hit","dying","weak","dead","die"];
         var _loc3_:int = 0;
         for each(_loc4_ in param1.currentLabels)
         {
            _loc5_ = String(_loc4_.name).toLowerCase();
            if(_loc2_.indexOf(_loc5_) >= 0 || /^moves?_?\d+(?:_\d+)?$/i.test(_loc5_))
            {
               _loc3_++;
            }
         }
         return _loc3_;
      }
      
      private function resumeChildren(param1:DisplayObjectContainer) : void
      {
         var _loc3_:DisplayObject = null;
         var _loc4_:MovieClip = null;
         var _loc5_:DisplayObjectContainer = null;
         if(param1 == null)
         {
            return;
         }
         var _loc2_:int = 0;
         while(_loc2_ < param1.numChildren)
         {
            _loc3_ = param1.getChildAt(_loc2_);
            _loc4_ = _loc3_ as MovieClip;
            if(_loc4_ != null && _loc4_.totalFrames > 1)
            {
               _loc4_.play();
            }
            _loc5_ = _loc3_ as DisplayObjectContainer;
            if(_loc5_ != null)
            {
               this.resumeChildren(_loc5_);
            }
            _loc2_++;
         }
      }
      
      private function stopChildren(param1:DisplayObjectContainer) : void
      {
         var _loc3_:DisplayObject = null;
         var _loc4_:MovieClip = null;
         var _loc5_:DisplayObjectContainer = null;
         if(param1 == null)
         {
            return;
         }
         var _loc2_:int = 0;
         while(_loc2_ < param1.numChildren)
         {
            _loc3_ = param1.getChildAt(_loc2_);
            _loc4_ = _loc3_ as MovieClip;
            if(_loc4_ != null)
            {
               _loc4_.stop();
            }
            _loc5_ = _loc3_ as DisplayObjectContainer;
            if(_loc5_ != null)
            {
               this.stopChildren(_loc5_);
            }
            _loc2_++;
         }
      }
      
      private function freezeThumbnail() : void
      {
         if(this.mode !== "thumbnail" || this.model == null)
         {
            return;
         }
         this.model.stop();
         this.stopChildren(this.model);
         this.fitModel();
      }
      
      private function scheduleFitRetry() : void
      {
         var serial:int = 0;
         var attempt:int = 0;
         var retry:Function = null;
         serial = ++this.fitRetrySerial;
         attempt = 0;
         retry = function():void
         {
            if(serial != fitRetrySerial)
            {
               return;
            }
            ++attempt;
            if(fitModel())
            {
               return;
            }
            ++cameraFitRetryCount;
            if(attempt < 8)
            {
               setTimeout(retry,Math.min(400,attempt * 60));
            }
         };
         setTimeout(retry,0);
      }
      
      private function fitModel() : Boolean
      {
         var oldHolderScaleX:Number;
         var oldHolderScaleY:Number;
         var oldHolderX:Number;
         var oldHolderY:Number;
         var oldModelScaleX:Number;
         var oldModelScaleY:Number;
         var oldModelX:Number;
         var oldModelY:Number;
         var width:Number;
         var height:Number;
         var referenceWidth:Number;
         var referenceHeight:Number;
         var padding:Number;
         var maxScale:Number;
         var scale:Number;
         var centred:Boolean;
         var bounds:Rectangle = null;
         if(this.model == null || this.holder == null)
         {
            return false;
         }
         oldHolderScaleX = this.holder.scaleX;
         oldHolderScaleY = this.holder.scaleY;
         oldHolderX = this.holder.x;
         oldHolderY = this.holder.y;
         oldModelScaleX = this.model.scaleX;
         oldModelScaleY = this.model.scaleY;
         oldModelX = this.model.x;
         oldModelY = this.model.y;
         this.holder.scaleX = this.holder.scaleY = 1;
         this.holder.x = this.holder.y = 0;
         this.model.scaleX = this.model.scaleY = 1;
         this.model.x = this.model.y = 0;
         try
         {
            bounds = this.usableBounds(this.actionBounds == null ? this.visualBounds() : this.actionBounds.clone());
         }
         catch(error:*)
         {
            bounds = null;
         }
         if(bounds == null)
         {
            this.holder.scaleX = oldHolderScaleX;
            this.holder.scaleY = oldHolderScaleY;
            this.holder.x = oldHolderX;
            this.holder.y = oldHolderY;
            this.model.scaleX = oldModelScaleX;
            this.model.scaleY = oldModelScaleY;
            this.model.x = oldModelX;
            this.model.y = oldModelY;
            return false;
         }
         width = stage == null ? 720 : Math.max(1,stage.stageWidth);
         height = stage == null ? 430 : Math.max(1,stage.stageHeight);
         referenceWidth = this.baseViewWidth > 0 ? this.baseViewWidth : width;
         referenceHeight = this.baseViewHeight > 0 ? this.baseViewHeight : height;
         padding = Math.max(4,Math.min(35,Math.min(referenceWidth,referenceHeight) * 0.12));
         if(this.mode === "fight" && !this.uClientBattleCamera)
         {
            this.uClientBattleCamera = this.supportsUClientBattleCamera(this.model);
         }
         if(this.mode === "thumbnail")
         {
            maxScale = 8;
         }
         else
         {
            maxScale = 1.0;
         }
         scale = Math.min((referenceWidth - padding * 2) / bounds.width,(referenceHeight - padding * 2) / bounds.height,maxScale);
         if(scale < 0.08)
         {
            scale = 0.08;
         }
         this.model.x = -(bounds.x + bounds.width / 2);
         this.model.y = -(bounds.y + bounds.height / 2);
         this.holder.scaleX = this.holder.scaleY = scale;
         centred = this.mode === "skill" || this.mode !== "effect" && (this.currentActionKey === "idle" || this.currentActionKey === "lowhp");
         if(centred)
         {
            this.holder.x = referenceWidth / 2 + (this.wideView ? Math.max(0,(width - referenceWidth) / 2) : 0);
            this.holder.y = referenceHeight / 2 + (this.wideView ? Math.max(0,(height - referenceHeight) / 2) : 0);
         }
         else
         {
            this.holder.x = padding + bounds.width * scale / 2;
            this.holder.y = referenceHeight / 2 + (this.wideView ? Math.max(0,(height - referenceHeight) / 2) : 0);
         }
         if(this.mode === "fight" && this.currentActionKey === "idle")
         {
            this.battleIdleBounds = bounds.clone();
            this.actionBounds = bounds.clone();
         }
         this.lastCameraBounds = bounds.clone();
         ++this.cameraFitCount;
         return true;
      }
      
      private function setWideView(param1:*) : Boolean
      {
         this.wideView = param1 === true || String(param1) === "1" || String(param1).toLowerCase() === "true";
         this.fitModel();
         return this.wideView;
      }
      
      private function stableBattleBounds() : Rectangle
      {
         if(this.battleIdleBounds != null)
         {
            return this.battleIdleBounds.clone();
         }
         var _loc1_:Rectangle = this.visualBounds();
         return _loc1_ == null ? null : _loc1_.clone();
      }
      
      private function getCameraState() : Object
      {
         return {
            "stageWidth":(stage == null ? 0 : stage.stageWidth),
            "stageHeight":(stage == null ? 0 : stage.stageHeight),
            "baseWidth":this.baseViewWidth,
            "baseHeight":this.baseViewHeight,
            "holderX":(this.holder == null ? 0 : this.holder.x),
            "holderY":(this.holder == null ? 0 : this.holder.y),
            "scale":(this.holder == null ? 0 : this.holder.scaleX),
            "wide":this.wideView,
            "uClientBattleCamera":this.uClientBattleCamera,
            "fitCount":this.cameraFitCount,
            "retryCount":this.cameraFitRetryCount,
            "bounds":(this.lastCameraBounds == null ? null : {
               "x":this.lastCameraBounds.x,
               "y":this.lastCameraBounds.y,
               "width":this.lastCameraBounds.width,
               "height":this.lastCameraBounds.height
            })
         };
      }
      
      private function usableBounds(param1:Rectangle) : Rectangle
      {
         if(param1 == null || !isFinite(param1.x) || !isFinite(param1.y) || !isFinite(param1.width) || !isFinite(param1.height) || param1.width < 1 || param1.height < 1)
         {
            return null;
         }
         return param1;
      }
      
      private function visualBounds() : Rectangle
      {
         var sample:Number;
         var bitmapWidth:int;
         var bitmapHeight:int;
         var bitmap:BitmapData;
         var matrix:Matrix = null;
         var pixels:Rectangle = null;
         var raw:Rectangle = this.model.getBounds(this.model);
         if(raw.width < 1 || raw.height < 1)
         {
            return raw;
         }
         sample = Math.min(1,1400 / raw.width,1000 / raw.height);
         bitmapWidth = Math.max(1,Math.ceil(raw.width * sample));
         bitmapHeight = Math.max(1,Math.ceil(raw.height * sample));
         bitmap = new BitmapData(bitmapWidth,bitmapHeight,true,0);
         try
         {
            matrix = new Matrix();
            matrix.scale(sample,sample);
            matrix.translate(-raw.x * sample,-raw.y * sample);
            bitmap.draw(this.model,matrix,null,null,null,true);
            pixels = bitmap.getColorBoundsRect(4278190080,0,false);
            if(pixels.width > 0 && pixels.height > 0)
            {
               return new Rectangle(raw.x + pixels.x / sample,raw.y + pixels.y / sample,pixels.width / sample,pixels.height / sample);
            }
         }
         finally
         {
            bitmap.dispose();
         }
         return raw;
      }
      
      private function onError(param1:IOErrorEvent) : void
      {
         this.notify("error",[],param1.text);
      }
      
      public function disposePreview() : Boolean
      {
         ++this.fitRetrySerial;
         ++this.terminalSerial;
         this.stopActionMonitor();
         if(stage != null)
         {
            stage.removeEventListener(Event.RESIZE,this.onResize);
         }
         if(this.model != null)
         {
            try
            {
               if(this.model["disposeUClientBattleResources"] is Function)
               {
                  this.model["disposeUClientBattleResources"]();
               }
            }
            catch(ignoredBattleDispose:*)
            {
            }
            try
            {
               if(this.model["disposePlayback"] is Function)
               {
                  this.model["disposePlayback"]();
               }
            }
            catch(ignoredPlaybackDispose:*)
            {
            }
            try
            {
               this.stopChildren(this.model);
            }
            catch(ignoredStop:*)
            {
            }
            try
            {
               if(this.holder != null && this.holder.contains(this.model))
               {
                  this.holder.removeChild(this.model);
               }
            }
            catch(ignoredRemove:*)
            {
            }
         }
         if(this.loader != null)
         {
            try
            {
               this.loader.contentLoaderInfo.removeEventListener(Event.COMPLETE,this.onLoaded);
            }
            catch(ignoredComplete:*)
            {
            }
            try
            {
               this.loader.contentLoaderInfo.removeEventListener(IOErrorEvent.IO_ERROR,this.onError);
            }
            catch(ignoredIo:*)
            {
            }
            try
            {
               this.loader.unloadAndStop(true);
            }
            catch(ignoredUnload:*)
            {
               try
               {
                  loader.unload();
               }
               catch(ignoredLegacyUnload:*)
               {
               }
            }
         }
         this.model = null;
         this.actionTarget = null;
         this.uClientSpineClip = null;
         this.nestedActionClip = null;
         this.loader = null;
         this.holder = null;
         this.available = [];
         this.managedPlayback = false;
         this.managedReady = false;
         this.uClientBattleCamera = false;
         this.actionBounds = null;
         this.battleIdleBounds = null;
         this.lastCameraBounds = null;
         return true;
      }
      
      private function notify(param1:String, param2:Array, param3:String) : void
      {
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.call(this.callbackName,param1,param2,param3);
            }
         }
         catch(ignored:*)
         {
         }
      }
   }
}

