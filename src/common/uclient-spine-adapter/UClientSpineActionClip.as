package
{
   import flash.display.BitmapData;
   import flash.display.BlendMode;
   import flash.display.MovieClip;
   import flash.display.Shape;
   import flash.events.Event;
   import flash.geom.ColorTransform;
   import flash.geom.Matrix;
   import flash.geom.Rectangle;
   import flash.utils.ByteArray;
   import flash.utils.getTimer;

   import spine.Event;
   import spine.Skeleton;
   import spine.SkeletonBinary;
   import spine.SkeletonClipping;
   import spine.SkeletonData;
   import spine.Slot;
   import spine.animation.Animation;
   import spine.animation.AnimationState;
   import spine.animation.AnimationStateData;
   import spine.animation.MixBlend;
   import spine.animation.MixDirection;
   import spine.atlas.Atlas;
   import spine.atlas.AtlasRegion;
   import spine.attachments.AtlasAttachmentLoader;
   import spine.attachments.Attachment;
   import spine.attachments.ClippingAttachment;
   import spine.attachments.MeshAttachment;
   import spine.attachments.RegionAttachment;
   import spine.flash.FlashTextureLoader;

   /** CPU-only renderer for the official U-client Spine 4.0 resource family. */
   public class UClientSpineActionClip extends MovieClip
   {
      public var hit:Number = 0;
      private var _manifest:Object;
      private var _data:SkeletonData;
      private var _skeleton:Skeleton;
      private var _state:AnimationState;
      private var _animation:Animation;
      private var _standbyAnimation:Animation;
      private var _actionTiming:Object;
      private var _actionName:String = "standby";
      private var _shapes:Array = [];
      private var _clipper:SkeletonClipping = new SkeletonClipping();
      private var _playing:Boolean = true;
      private var _loop:Boolean = true;
      private var _current:int = 1;
      private var _total:int = 2;
      private var _elapsed:Number = 0;
      private var _lastTick:int = 0;
      private var _modelScale:Number = 60;
      private var _centerX:Number = 0;
      private var _baselineY:Number = 0;
      private var _fallbackHitAt:Number = 0;
      private var _peakShapes:int = 0;
      private var _drawCalls:Number = 0;
      private var _pendingDelta:Number = 0;
      private var _renderAccumulator:Number = 0;
      private var _renderInterval:Number = 1 / 30;
      private var _actionDuration:Number = 0;
      private var _returnMixSeconds:Number = 0;
      private var _suspendedGapCount:int = 0;
      private var _vertexScratch:Vector.<Number> = new Vector.<Number>();
      private var _outputScratch:Vector.<Number> = new Vector.<Number>();
      private var _indexScratch:Vector.<int> = new Vector.<int>();
      private static const REGION_TRIANGLES:Vector.<uint> = Vector.<uint>([0,1,2,2,3,0]);
      private static const LOGIC_STEP_SECONDS:Number = .12;
      private static const APPLICATION_SUSPEND_SECONDS:Number = 1;

      public function UClientSpineActionClip(atlasBytes:ByteArray,skeletonBytes:ByteArray,
         pages:Object,manifest:Object)
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         _manifest = manifest || {};
         atlasBytes.position = 0;
         skeletonBytes.position = 0;
         var atlas:Atlas;
         var binary:SkeletonBinary;
         try { atlas = new Atlas(atlasBytes,new FlashTextureLoader(pages)); }
         catch(atlasError:*) { throw new Error("atlas-parse: " + atlasError); }
         try
         {
            binary = new SkeletonBinary(new AtlasAttachmentLoader(atlas));
            binary.scale = Math.max(.000001,Number(_manifest.scale || .01));
            _data = binary.readSkeletonData(skeletonBytes);
         }
         catch(skeletonError:*) { throw new Error("skeleton-binary: " + skeletonError); }
         try
         {
            try { _skeleton = new Skeleton(_data); }
            catch(createError:*) { throw new Error("create-skeleton: " + createError); }
            try
            {
               var stateData:AnimationStateData = new AnimationStateData(_data);
               _returnMixSeconds = officialReturnMixSeconds();
               stateData.defaultMix = _returnMixSeconds;
               _state = new AnimationState(stateData);
               _state.onEvent.add(onSpineEvent);
               _standbyAnimation = _data.findAnimation("await");
            }
            catch(stateError:*) { throw new Error("create-state: " + stateError); }
            try { computeStandbyCamera(); }
            catch(cameraError:*) { throw new Error("standby-camera: " + cameraError); }
         }
         catch(runtimeError:*) { throw new Error("skeleton-runtime: " + runtimeError); }
         addEventListener(flash.events.Event.ENTER_FRAME,onEnterFrame,false,0,true);
      }

      public function get ready():Boolean { return _data != null && _skeleton != null; }
      /** This self-contained renderer owns its real-time animation clock. */
      public function get uClientBattleClockManaged():Boolean { return true; }
      public function get rendererMode():String { return "cpu-spine40"; }
      public function get actionDurationSeconds():Number { return _actionDuration; }
      public function get rendererDiagnostics():Object
      {
         return { active:false,pending:false,failed:false,mode:rendererMode,
            policy:"uclient-spine-runtime-resource-local-texture",
            pageCount:_manifest && _manifest.pageNames is Array ? _manifest.pageNames.length : 0,
            shapes:_shapes.length,peakShapes:_peakShapes,drawCalls:_drawCalls,
            modelScale:_modelScale,selectedAction:_actionName,
            animationName:_animation == null ? "" : _animation.name,
            animationDuration:_animation == null ? 0 : Number(_animation.duration),
            actionDuration:_actionDuration,fallbackHitAt:_fallbackHitAt,
            suspendedGapCount:_suspendedGapCount,renderInterval:_renderInterval,
            officialTimingApplied:_actionTiming != null };
      }
      override public function get currentFrame():int { return _current; }
      override public function get totalFrames():int { return Math.max(2,_total); }
      public function get elapsedSeconds():Number { return _elapsed; }
      override public function play():void
      {
         _playing = true;
         _pendingDelta = 0;
         _renderAccumulator = 0;
         _lastTick = getTimer();
      }
      override public function stop():void { if(!_loop) _playing = false; }
      override public function gotoAndPlay(frame:Object,scene:String = null):void
      {
         seek(frame is Number || frame is int || frame is uint ? int(frame) : 1); _playing = true;
      }
      override public function gotoAndStop(frame:Object,scene:String = null):void
      {
         seek(frame is Number || frame is int || frame is uint ? int(frame) : 1);
         if(!_loop) _playing = false;
      }

      public function select(name:String):void
      {
         _actionName = String(name || "standby").toLowerCase();
         var actual:String = _actionName == "standby" || _actionName == "idle" ? "await" : _actionName;
         _animation = _data.findAnimation(actual);
         if(_animation == null && /^(sa5|as5|attack5|moves?[_-]?\d+|ultimate)/i.test(actual))
            _animation = _data.findAnimation("hidemove") || _data.findAnimation("attack");
         if(_animation == null) _animation = _data.findAnimation("await") || _data.animations[0];
         var resolvedAction:String = _animation == null ? actual : String(_animation.name || actual).toLowerCase();
         _loop = resolvedAction == "await";
         _actionTiming = officialActionTiming(resolvedAction,_animation);
         // The authored Spine runtime and the self-contained Flash template are
         // both 30 Hz. Keep every action, including mesh-heavy standby loops, at
         // that cadence. Complexity may change allocation strategy, but it must
         // not silently lower visible animation density.
         _renderInterval = 1 / 30;
         _pendingDelta = 0;
         _renderAccumulator = 0;
         _state.clearTracks();
         _skeleton.setToSetupPose();
         _state.setAnimation(0,_animation,_loop);
         // A profile is accepted only when the official video, native embedded
         // SWF and Spine skeleton hashes all match.  For those audited actions,
         // preserve the official final 0.1-second mix back to await so an
         // off-screen last keyed pose cannot snap directly into standby.
         if(!_loop && _actionTiming != null && _returnMixSeconds > 0 &&
            _standbyAnimation != null && _animation !== _standbyAnimation)
            _state.addAnimation(0,_standbyAnimation,true,0);
         _elapsed = 0;
         _current = 1;
         _actionDuration = _actionTiming == null ? Number(_animation.duration) :
            Number(_actionTiming.durationSeconds);
         _total = Math.max(2,Math.ceil(_actionDuration * 30) + 1);
         _fallbackHitAt = _actionTiming != null && _actionTiming.hasOwnProperty("hitSeconds") &&
            !isNaN(Number(_actionTiming.hitSeconds)) && Number(_actionTiming.hitSeconds) >= 0 ?
            Math.min(_actionDuration,Number(_actionTiming.hitSeconds)) :
            Number.MAX_VALUE;
         hit = 0;
         _playing = true;
         _lastTick = getTimer();
         _state.apply(_skeleton);
         _skeleton.updateWorldTransform();
         drawSkeleton();
      }

      private function seek(frame:int):void
      {
         if(_animation == null) return;
         select(_actionName);
         var target:Number = Math.max(0,Math.min(_actionDuration,(frame - 1) / 30));
         _state.update(target);
         _state.apply(_skeleton);
         _skeleton.updateWorldTransform();
         _elapsed = target;
         _pendingDelta = 0;
         _renderAccumulator = 0;
         _current = Math.max(1,Math.min(totalFrames,frame));
         if(_elapsed >= _fallbackHitAt) hit = 1;
         drawSkeleton();
      }

      private function onEnterFrame(event:flash.events.Event):void
      {
         if(!_playing || _animation == null) return;
         var now:int = getTimer();
         var wallDelta:Number = Math.max(0,(now - _lastTick) / 1000);
         _lastTick = now;
         // A multi-second gap means the Flash application itself was suspended,
         // not that the renderer owes thousands of catch-up frames. Preserve
         // the current action across that lifecycle boundary. Short active
         // stalls retain their complete elapsed time and are advanced below in
         // bounded logical slices; only already-expired visual submissions may
         // be coalesced into the current visible pose.
         if(wallDelta > APPLICATION_SUSPEND_SECONDS)
         {
            _pendingDelta = 0;
            _renderAccumulator = 0;
            _suspendedGapCount++;
            return;
         }
         _elapsed += wallDelta;
         _pendingDelta += wallDelta;
         _renderAccumulator += wallDelta;
         if(_elapsed >= _fallbackHitAt) hit = 1;
         _current = Math.max(1,Math.min(totalFrames,Math.floor(_elapsed * 30) + 1));
         if(_renderAccumulator + .000001 < _renderInterval && (_loop || _elapsed < _actionDuration)) return;
         while(_pendingDelta > .000001)
         {
            var logicStep:Number = Math.min(LOGIC_STEP_SECONDS,_pendingDelta);
            _state.update(logicStep);
            _pendingDelta = Math.max(0,_pendingDelta - logicStep);
         }
         _renderAccumulator = Math.max(0,_renderAccumulator - _renderInterval);
         _state.apply(_skeleton);
         _skeleton.updateWorldTransform();
         drawSkeleton();
         if(!_loop && _elapsed >= _actionDuration)
         {
            _elapsed = _actionDuration;
            _current = totalFrames;
            _playing = false;
         }
      }

      private function onSpineEvent(entry:*,event:spine.Event):void
      {
         var name:String = String(event && event.data && event.data.name || "").toLowerCase();
         // In some official assets a Spine event named "hit" is a visual cue,
         // while the U Timeline signal track dispatches battle damage later.
         // When an exact audited action timing exists, that Timeline signal is
         // authoritative.  Unprofiled resources retain their native event.
         if(_actionTiming != null && _actionTiming.hasOwnProperty("hitSeconds")) return;
         if(name == "hit" || name == "hited" || name == "action_hit") hit = 1;
      }

      private function officialReturnMixSeconds():Number
      {
         var skillTimeline:Object = _manifest == null ? null : _manifest.skillTimeline;
         var cinematic:Object = _manifest == null ? null : _manifest.cinematic;
         // A disabled overlay manifest may retain diagnostic/profile metadata,
         // but it must not alter an ordinary Spine/cinematic action clock.
         // Only an embedded and enabled SkillTimeline is authoritative.
         var timing:Object = skillTimeline != null && skillTimeline.enabled === true &&
            skillTimeline.actionTiming != null ?
            skillTimeline.actionTiming : (cinematic == null ? null : cinematic.actionTiming);
         var value:Number = Number(timing == null ? 0 : timing.returnMixSeconds);
         return isNaN(value) ? 0 : Math.max(0,Math.min(.5,value));
      }

      private function officialActionTiming(action:String,animation:Animation):Object
      {
         var skillTimeline:Object = _manifest == null ? null : _manifest.skillTimeline;
         var cinematic:Object = _manifest == null ? null : _manifest.cinematic;
         var timing:Object = skillTimeline != null && skillTimeline.enabled === true &&
            skillTimeline.actionTiming != null ?
            skillTimeline.actionTiming : (cinematic == null ? null : cinematic.actionTiming);
         var actions:Object = timing == null ? null : timing.actions;
         var record:Object = actions == null ? null : actions[action];
         if(record == null || animation == null) return null;
         var expected:Number = Number(record.durationSeconds);
         var tolerance:Number = Number(timing.durationToleranceSeconds);
         if(isNaN(expected) || expected <= 0) return null;
         if(isNaN(tolerance) || tolerance <= 0) tolerance = .05;
         // The official Timeline envelope may intentionally outlive the Spine
         // clip so its hit/settle/return tail can finish.  Reject only a profile
         // that would shorten authored Spine motion; exact skeleton hashing is
         // what proves the positive extension belongs to this resource.
         if(expected + tolerance < Number(animation.duration)) return null;
         var hitSeconds:Number = Number(record.hitSeconds);
         if(!isNaN(hitSeconds) && (hitSeconds < 0 || hitSeconds > expected + tolerance)) return null;
         return record;
      }

      private function computeStandbyCamera():void
      {
         var bounds:Array = [Number.MAX_VALUE,Number.MAX_VALUE,-Number.MAX_VALUE,-Number.MAX_VALUE];
         // Some official 4.0 timelines contain keyed data that cannot be
         // sampled with Animation.apply before an AnimationState has owned the
         // track (RangeError #1125 in the Flash runtime).  The setup pose is
         // authoritative for the model's scene units and is available for
         // every Spine resource, so derive the initial camera from it.  Action
         // effects may extend outside this box without shrinking the fighter.
         _skeleton.setToSetupPose();
         _skeleton.updateWorldTransform();
         includeSkeletonBounds(_skeleton,bounds);
         if(bounds[0] == Number.MAX_VALUE) bounds = [-1,0,1,2];
         var width:Number = Math.max(.001,bounds[2] - bounds[0]);
         var height:Number = Math.max(.001,bounds[3] - bounds[1]);
         var fitted:Number = Math.min(64,340 / width,360 / height);
         // Large authored bounds must be allowed to fit below the historical
         // 50-unit floor. This mirrors the FTR structural camera policy and
         // prevents oversized Spine models from covering battle controls.
         _modelScale = fitted * 1.22;
         _centerX = (bounds[0] + bounds[2]) / 2;
         _baselineY = bounds[1];
      }

      private function includeSkeletonBounds(skeleton:Skeleton,bounds:Array):void
      {
         for each(var slot:Slot in skeleton.drawOrder)
         {
            var attachment:Attachment = slot.attachment;
            var vertices:Vector.<Number> = null;
            if(attachment is RegionAttachment)
            {
               vertices = new Vector.<Number>(8,true);
               RegionAttachment(attachment).computeWorldVertices(slot.bone,vertices,0,2);
            }
            else if(attachment is MeshAttachment)
            {
               vertices = new Vector.<Number>(MeshAttachment(attachment).worldVerticesLength,true);
               MeshAttachment(attachment).computeWorldVertices(slot,0,vertices.length,vertices,0,2);
            }
            if(vertices == null) continue;
            for(var index:int = 0; index + 1 < vertices.length; index += 2)
            {
               bounds[0] = Math.min(bounds[0],vertices[index]);
               bounds[1] = Math.min(bounds[1],vertices[index + 1]);
               bounds[2] = Math.max(bounds[2],vertices[index]);
               bounds[3] = Math.max(bounds[3],vertices[index + 1]);
            }
         }
      }

      private function drawSkeleton():void
      {
         var used:int = 0;
         _clipper.clipEnd();
         for each(var slot:Slot in _skeleton.drawOrder)
         {
            if(!slot.bone.active) continue;
            var attachment:Attachment = slot.attachment;
            if(attachment is ClippingAttachment)
            {
               _clipper.clipStart(slot,ClippingAttachment(attachment));
               continue;
            }
            var vertices:Vector.<Number>;
            var uvs:Vector.<Number>;
            var triangles:Vector.<uint>;
            var region:AtlasRegion;
            var attachmentColor:*;
            if(attachment is RegionAttachment)
            {
               var regionAttachment:RegionAttachment = RegionAttachment(attachment);
               _vertexScratch.length = 8;
               vertices = _vertexScratch;
               regionAttachment.computeWorldVertices(slot.bone,vertices,0,2);
               uvs = regionAttachment.uvs;
               triangles = REGION_TRIANGLES;
               region = AtlasRegion(regionAttachment.rendererObject);
               attachmentColor = regionAttachment.color;
            }
            else if(attachment is MeshAttachment)
            {
               var mesh:MeshAttachment = MeshAttachment(attachment);
               _vertexScratch.length = mesh.worldVerticesLength;
               vertices = _vertexScratch;
               mesh.computeWorldVertices(slot,0,vertices.length,vertices,0,2);
               uvs = mesh.uvs;
               triangles = mesh.triangles;
               region = AtlasRegion(mesh.rendererObject);
               attachmentColor = mesh.color;
            }
            else
            {
               _clipper.clipEndWithSlot(slot);
               continue;
            }
            if(_clipper.isClipping())
            {
               _clipper.clipTriangles(vertices,triangles,triangles.length,uvs);
               vertices = _clipper.clippedVertices;
               uvs = _clipper.clippedUvs;
               triangles = _clipper.clippedTriangles;
            }
            if(vertices.length >= 6 && triangles.length >= 3 && region && region.page.rendererObject is BitmapData)
            {
               var shape:Shape = shapeAt(used++);
               shape.graphics.clear();
               shape.alpha = 1;
               shape.blendMode = blendModeFor(slot.data.blendMode.ordinal);
               var transform:ColorTransform = shape.transform.colorTransform;
               transform.redMultiplier = _skeleton.color.r * slot.color.r * attachmentColor.r;
               transform.greenMultiplier = _skeleton.color.g * slot.color.g * attachmentColor.g;
               transform.blueMultiplier = _skeleton.color.b * slot.color.b * attachmentColor.b;
               transform.alphaMultiplier = _skeleton.color.a * slot.color.a * attachmentColor.a;
               shape.transform.colorTransform = transform;
               _outputScratch.length = vertices.length;
               var output:Vector.<Number> = _outputScratch;
               for(var point:int = 0; point + 1 < vertices.length; point += 2)
               {
                  output[point] = (vertices[point] - _centerX) * _modelScale;
                  output[point + 1] = -(vertices[point + 1] - _baselineY) * _modelScale;
               }
               _indexScratch.length = triangles.length;
               for(var triangleIndex:int = 0; triangleIndex < triangles.length; triangleIndex++)
                  _indexScratch[triangleIndex] = int(triangles[triangleIndex]);
               shape.graphics.beginBitmapFill(BitmapData(region.page.rendererObject),null,false,true);
               shape.graphics.drawTriangles(output,_indexScratch,uvs);
               shape.graphics.endFill();
               _drawCalls++;
            }
            _clipper.clipEndWithSlot(slot);
         }
         _clipper.clipEnd();
         while(used < _shapes.length)
         {
            var unused:Shape = Shape(_shapes[used++]);
            unused.graphics.clear(); unused.alpha = 1; unused.blendMode = flash.display.BlendMode.NORMAL;
            unused.transform.colorTransform = new ColorTransform();
         }
         _peakShapes = Math.max(_peakShapes,_shapes.length);
      }

      private function shapeAt(index:int):Shape
      {
         while(_shapes.length <= index)
         {
            var shape:Shape = new Shape();
            _shapes.push(shape); addChild(shape);
         }
         return Shape(_shapes[index]);
      }
      private function blendModeFor(ordinal:int):String
      {
         if(ordinal == 1) return flash.display.BlendMode.ADD;
         if(ordinal == 2) return flash.display.BlendMode.MULTIPLY;
         if(ordinal == 3) return flash.display.BlendMode.SCREEN;
         return flash.display.BlendMode.NORMAL;
      }

      public function visualDigest():Object
      {
         var bounds:Rectangle = getBounds(this);
         if(bounds == null || bounds.isEmpty()) return { empty:true,renderer:rendererMode };
         var left:int = Math.floor(bounds.left), top:int = Math.floor(bounds.top);
         var width:int = Math.max(1,Math.ceil(bounds.right)-left);
         var height:int = Math.max(1,Math.ceil(bounds.bottom)-top);
         if(width > 4095 || height > 4095) return { empty:true,error:"bounds-too-large",width:width,height:height };
         var pixels:BitmapData = new BitmapData(width,height,true,0);
         pixels.draw(this,new Matrix(1,0,0,1,-left,-top),null,null,null,true);
         var occupied:Rectangle = pixels.getColorBoundsRect(0xff000000,0,false);
         var result:Object = { empty:occupied.isEmpty(),renderer:rendererMode,
            bounds:[left,top,width,height],occupied:[occupied.x,occupied.y,occupied.width,occupied.height] };
         pixels.dispose(); return result;
      }
   }
}
