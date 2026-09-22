package
{
   import flash.display.BitmapData;
   import flash.display.Bitmap;
   import flash.display.BlendMode;
   import flash.display.MovieClip;
   import flash.display.Shape;
   import flash.events.Event;
   import flash.geom.Matrix;
   import flash.geom.Point;
   import flash.geom.Rectangle;
   import flash.utils.getTimer;

   /**
    * CPU-only renderer for the official FTRuntime pet meshes.
    *
    * The surrounding battle players deliberately see a MovieClip-like action:
    * currentFrame/totalFrames advance, hit becomes true on action_hit, and the
    * last frame remains observable long enough for their normal completion
    * logic.  Rendering itself uses Graphics.drawTriangles, not Stage3D/GPU.
    */
   public class UClientFtrActionClip extends MovieClip
   {
      public var hit:Number = 0;

      public function get ready():Boolean
      {
         return _data != null && _sequence != null && _pageFactories.length > 0 &&
            _data.pages is Array && _pageFactories.length >= _data.pages.length;
      }

      /** This self-contained renderer exclusively owns its real-time clock. */
      public function get uClientBattleClockManaged():Boolean
      {
         return true;
      }

      public function get rendererMode():String
      {
         return "cpu";
      }

      /** Internal authored mask/content groups are scaled in-place. */
      public function get uClientInternalBackgroundScale():Boolean
      {
         return true;
      }

      public function get rendererDiagnostics():Object
      {
         var resident:Array = [];
         for(var index:int = 0; index < _pages.length; index++)
            if(_pages[index] is BitmapData) resident.push(index);
         return {
            active:false, pending:false, failed:false, mode:"cpu",
            policy:"resource-local-quality-model-residency",
            residentPages:resident.length, residentIndices:resident,
            residentBytes:_residentBytes, peakResidentBytes:_peakResidentBytes,
            pageCreates:_pageCreates, pageDisposals:_pageDisposals,
            visualFramesSkipped:_visualFramesSkipped,
            eventPaused:_eventPaused, actionEpoch:_actionEpoch,
            missingPageLoads:_missingPageLoads,
            quadDrawCalls:_quadDrawCalls,
            uvCacheBuilds:_uvCacheBuilds,
            geometryScratchReuses:_geometryScratchReuses,
            internalBackgroundFrames:_internalBackgroundFrameCount,
            internalBackgroundGroups:_internalBackgroundGroupCount,
            perQuadTemporaryAllocations:0,
            prefetchFrames:PREFETCH_FRAME_WINDOW,
            releaseGraceFrames:RELEASE_GRACE_FRAMES,
            residencyWindowPages:_residencyWindowPages
         };
      }

      /**
       * Produces a renderer-independent pixel summary for isolated validation.
       * This is deliberately called on demand (never from ENTER_FRAME), so it
       * does not add work to normal gameplay.  It lets the x32 harness verify
       * direct-wmode Flash even though Electron capturePage cannot see the
       * Pepper plugin surface.
       */
      public function visualDigest():Object
      {
         var bounds:Rectangle = getBounds(this);
         if(bounds == null || bounds.isEmpty())
            return { empty:true, renderer:rendererMode };
         var left:int = Math.floor(bounds.left);
         var top:int = Math.floor(bounds.top);
         var width:int = Math.max(1,Math.ceil(bounds.right) - left);
         var height:int = Math.max(1,Math.ceil(bounds.bottom) - top);
         if(width > 4095 || height > 4095)
            return { empty:true, renderer:rendererMode, error:"bounds-too-large", width:width, height:height };
         var pixels:BitmapData = new BitmapData(width,height,true,0);
         var result:Object;
         try
         {
            pixels.draw(this,new Matrix(1,0,0,1,-left,-top),null,null,null,true);
            var occupied:Rectangle = pixels.getColorBoundsRect(0xff000000,0x00000000,false);
            var hash:uint = 2166136261;
            var alphaTotal:Number = 0;
            var luminanceTotal:Number = 0;
            var darkOpaqueSamples:int = 0;
            var lightOpaqueSamples:int = 0;
            var samples:int = 0;
            var stepX:int = Math.max(1,int(width / 64));
            var stepY:int = Math.max(1,int(height / 64));
            for(var y:int = 0; y < height; y += stepY)
            {
               for(var x:int = 0; x < width; x += stepX)
               {
                  var color:uint = pixels.getPixel32(x,y);
                  var sampleAlpha:int = color >>> 24;
                  var red:int = color >>> 16 & 255;
                  var green:int = color >>> 8 & 255;
                  var blue:int = color & 255;
                  var luminance:int = (red * 54 + green * 183 + blue * 19) >> 8;
                  alphaTotal += sampleAlpha;
                  luminanceTotal += luminance * sampleAlpha / 255;
                  if(sampleAlpha >= 224 && luminance <= 16) darkOpaqueSamples++;
                  if(sampleAlpha >= 224 && luminance >= 239) lightOpaqueSamples++;
                  hash = uint((hash ^ color) * 16777619);
                  samples++;
               }
            }
            result = {
               empty:occupied.isEmpty(), renderer:rendererMode,
               bounds:[left,top,width,height],
               occupied:[occupied.x,occupied.y,occupied.width,occupied.height],
               alphaTotal:alphaTotal, luminanceTotal:luminanceTotal,
               darkOpaqueSamples:darkOpaqueSamples,
               lightOpaqueSamples:lightOpaqueSamples,
               samples:samples, hash:hash.toString(16)
            };
         }
         catch(error:*)
         {
            result = { empty:true, renderer:rendererMode, error:String(error) };
         }
         pixels.dispose();
         return result;
      }

      private var _data:Object;
      private var _pages:Array = [];
      private var _pageFactories:Array = [];
      private var _residentBytes:Number = 0;
      private var _peakResidentBytes:Number = 0;
      private var _pageCreates:int = 0;
      private var _pageDisposals:int = 0;
      private var _visualFramesSkipped:int = 0;
      private var _missingPageLoads:int = 0;
      private var _sequence:Object;
      private var _actionName:String = "standby";
      private var _current:int = 1;
      private var _total:int = 240;
      private var _playing:Boolean = true;
      private var _eventPaused:Boolean = false;
      private var _actionEpoch:uint = 0;
      private var _lastDispatchedEventKey:String = "";
      private var _lastTick:int = 0;
      private var _frameAccumulator:Number = 0;
      private var _shapes:Array = [];
      private var _masks:Array = [];
      private var _uvCache:Array = [];
      private var _quadVertices:Vector.<Number> = Vector.<Number>([0,0,0,0,0,0,0,0]);
      private var _quadIndices:Vector.<int> = Vector.<int>([0,1,2,0,2,3]);
      private var _identityMatrix:Matrix = new Matrix();
      private var _quadDrawCalls:int = 0;
      private var _uvCacheBuilds:int = 0;
      private var _geometryScratchReuses:int = 0;
      private var _modelScale:Number = 48;
      private var _centerX:Number = 0;
      private var _baselineY:Number = 0;
      /** Keep only a bounded action/frame window decoded. */
      private static const PREFETCH_FRAME_WINDOW:int = 4;
      private static const RELEASE_GRACE_FRAMES:int = 8;
      private var _pageGrace:Array = [];
      private var _residencyFrame:int = -1;
      private var _residencyWindowPages:int = 0;
      // Internal authored background groups are transformed in-place.  They
      // remain ordinary ActionClip Shapes; no independent scene layer is ever
      // created.  Keys are frame|quad and are derived from material/mask
      // structure plus geometry, never from ids or skin tables.
      private var _internalGroupLookup:Object = {};
      private var _internalGroupTransforms:Object = {};
      private var _internalContractsByAction:Object = {};
      private var _internalBackgroundFrameCount:int = 0;
      private var _internalBackgroundGroupCount:int = 0;

      public function UClientFtrActionClip()
      {
         super();
         mouseEnabled = false;
         mouseChildren = false;
         addEventListener(Event.ENTER_FRAME,onEnterFrame,false,0,true);
         addEventListener(Event.ADDED_TO_STAGE,onAddedToStage,false,0,true);
      }

      override public function get currentFrame():int
      {
         return _current;
      }

      override public function get totalFrames():int
      {
         return Math.max(2,_total);
      }

      override public function play():void
      {
         beginAt(_current);
      }

      override public function stop():void
      {
         if(_actionName != "standby" && _actionName != "idle") _playing = false;
      }

      override public function gotoAndPlay(frame:Object, scene:String = null):void
      {
         beginAt(frame is Number || frame is int || frame is uint ? int(frame) : 1);
      }

      override public function gotoAndStop(frame:Object, scene:String = null):void
      {
         var requested:int = frame is Number || frame is int || frame is uint ? int(frame) : 1;
         _current = Math.max(1,Math.min(totalFrames,requested));
         // New UI uses gotoAndStop(1) for standby.  The original pet packages
         // have animated descendants there, so keep the UClientFtr standby alive too.
         if(_actionName == "standby" || _actionName == "idle") beginAt(_current);
         else
         {
            _playing = false;
            renderCurrent();
         }
      }

      public function install(data:Object, pages:Array, pageFactories:Array = null):void
      {
         if(_pages.length) releaseAllPages();
         _data = data;
         _pages = pages || [];
         _pageFactories = pageFactories || [];
         _pageGrace = new Array(Math.max(_pages.length,_pageFactories.length));
         _residencyFrame = -1;
         _residencyWindowPages = 0;
         _uvCache = [];
         _internalContractsByAction = {};
         _modelScale = Math.max(1,Number(_data && _data.modelScale || 48));
         _centerX = 0;
         _baselineY = 0;
         var standby:Object = findSequence("standby") || findSequence("idle");
         if(standby != null && standby.bounds is Array && standby.bounds.length >= 4)
         {
            _centerX = (Number(standby.bounds[0]) + Number(standby.bounds[2])) / 2;
            _baselineY = Number(standby.bounds[1]);
         }
         select(_actionName);
      }

      public function select(name:String):void
      {
         var previousSequence:Object = _sequence;
         _actionName = String(name || "standby").toLowerCase();
         _sequence = findSequence(_actionName);
         if(_sequence == null)
         {
            if(_actionName == "sa5" || _actionName.indexOf("move") == 0 || _actionName.indexOf("ultimate") == 0)
               _sequence = findSequence("sa");
            if(_sequence == null) _sequence = findSequence("standby") || findSequence("idle");
         }
         _total = _sequence && _sequence.frames is Array ? Math.max(2,_sequence.frames.length) : 240;
         // Reset only the bounded window for this action.  Never scan every
         // sequence during install or action selection; large U-client models
         // must not block the first visible frame.
         _residencyFrame = -1;
         _residencyWindowPages = 0;
         if(previousSequence !== null && previousSequence !== _sequence) clearDisplayGraphics();
         buildInternalBackgroundContract();
         hit = 0;
         _actionEpoch++;
         _eventPaused = false;
         _lastDispatchedEventKey = "";
         beginAt(1);
      }

      /** Freeze only this resource-local FTR clock while its authored video is
       * visible.  The host stage, the opponent and both battle UIs continue to
       * run normally. */
      public function pauseForEmbeddedVideo(actionEpoch:uint, actionName:String,
         sourceFrame:int):Boolean
      {
         if(actionEpoch != _actionEpoch || String(actionName || "").toLowerCase() != _actionName ||
            sourceFrame != _current - 1) return false;
         _eventPaused = true;
         return true;
      }

      public function resumeFromEmbeddedVideo(actionEpoch:uint):Boolean
      {
         if(actionEpoch != _actionEpoch || !_eventPaused) return false;
         _eventPaused = false;
         _lastTick = getTimer();
         _frameAccumulator = 0;
         _playing = true;
         return true;
      }

      public function get actionEpoch():uint { return _actionEpoch; }
      public function get eventPaused():Boolean { return _eventPaused; }

      private function findSequence(name:String):Object
      {
         if(!_data || !(_data.sequences is Array)) return null;
         for each(var sequence:Object in _data.sequences)
         {
            if(String(sequence.name || "").toLowerCase() == name) return sequence;
         }
         return null;
      }

      private function beginAt(frame:int):void
      {
         _current = Math.max(1,Math.min(totalFrames,frame));
         _lastTick = getTimer();
         _frameAccumulator = 0;
         _playing = true;
         renderCurrent();
      }

      private function onEnterFrame(event:Event):void
      {
         if(!_playing || _eventPaused || _sequence == null) return;
         var fps:Number = Math.max(1,Number(_data && _data.frameRate || 24));
         var now:int = getTimer();
         var elapsed:int = Math.max(0,Math.min(250,now - _lastTick));
         _lastTick = now;
         _frameAccumulator += elapsed * fps / 1000;
         if(_frameAccumulator < 1) return;
         // Catch up the UClientFtr model locally when its own mesh render falls
         // behind. Every crossed authored frame is rendered in order; no real
         // visual frame is discarded. This never changes stage.frameRate/
         // stage.quality or any host UI.
         var due:int = Math.max(1,Math.min(6,int(_frameAccumulator)));
         _frameAccumulator = Math.max(0,_frameAccumulator - due);
         for(var step:int = 0; step < due; step++)
         {
            if(!_playing || _eventPaused) break;
            var advanced:int = advanceLogicalFrames(1);
            if(advanced <= 0) break;
            renderCurrent();
            if(_current >= totalFrames)
            {
               if(_actionName == "standby" || _actionName == "idle") beginAt(1);
               else
               {
                  _playing = false;
                  break;
               }
            }
         }
      }

      private function onAddedToStage(event:Event):void
      {
         // Constructors can render before either battle host has attached the
         // pet to a Stage. Repaint immediately on attachment so the first frame
         // that can actually be presented already uses viewport-cover geometry.
         renderCurrent();
      }

      private function advanceLogicalFrames(count:int):int
      {
         if(_sequence == null || !(_sequence.frames is Array)) return 0;
         var frames:Array = _sequence.frames as Array;
         var advanced:int = 0;
         for(var step:int = 0; step < count; step++)
         {
            if(_current >= totalFrames)
            {
               if(_actionName == "standby" || _actionName == "idle") _current = 1;
               else break;
            }
            else _current++;
            advanced++;
            var frameIndex:int = Math.max(0,Math.min(frames.length - 1,_current - 1));
            updateSignalsFromFrame(frames[frameIndex],frameIndex);
            if(_eventPaused) break;
         }
         return advanced;
      }

      private function renderCurrent():void
      {
         if(_sequence == null || !(_sequence.frames is Array) || !_sequence.frames.length) return;
         var frameIndex:int = Math.max(0,Math.min(_sequence.frames.length - 1,_current - 1));
         var frame:Object = _sequence.frames[frameIndex];
         updateSignalsFromFrame(frame,frameIndex);
         drawFrame(frame);
      }

      private function updateSignalsFromFrame(frame:Object, frameIndex:int):void
      {
         if(frame == null) return;
         var labels:Array = frame.l is Array ? frame.l : [];
         for each(var value:* in labels)
         {
            var frameLabel:String = String(value || "");
            var normalized:String = frameLabel.toLowerCase();
            if(normalized == "action_hit") hit = 1;
            if(normalized.indexOf("event_video_") != 0 || normalized.length <= 12) continue;
            var eventKey:String = _actionEpoch + "|" + _actionName + "|" + frameIndex + "|" + normalized;
            if(eventKey == _lastDispatchedEventKey) continue;
            _lastDispatchedEventKey = eventKey;
            dispatchEvent(new UClientFtrFrameEvent(UClientFtrFrameEvent.EVENT_VIDEO,
               _actionName,frameIndex,frameLabel,frameLabel.substr(12),_actionEpoch));
         }
      }

      /**
       * Detect authored mask->material->mask groups that are substantially
       * larger than the standby envelope.  These are the real internal battle
       * backgrounds in compact FTR timelines.  The mask and all of its content
       * receive one local transform in drawFrame; the model and action root do
       * not move.  A group must recur across several frames so small body masks
       * and one-frame particles are rejected structurally.
       */
      private function buildInternalBackgroundContract():void
      {
         _internalGroupLookup = {};
         _internalGroupTransforms = {};
         _internalBackgroundFrameCount = 0;
         _internalBackgroundGroupCount = 0;
         if(_sequence == null || !(_sequence.frames is Array)) return;
         var cacheKey:String = String(_sequence.name || _actionName).toLowerCase();
         var cached:Object = _internalContractsByAction[cacheKey];
         if(cached != null)
         {
            _internalGroupLookup = cached.lookup;
            _internalGroupTransforms = cached.transforms;
            _internalBackgroundFrameCount = int(cached.frameCount || 0);
            _internalBackgroundGroupCount = int(cached.groupCount || 0);
            return;
         }
         if(actionMustRemainModelLocal() || actionUsesEventVideo())
         {
            cacheInternalBackgroundContract(cacheKey);
            return;
         }
         var standby:Object = findSequence("standby") || findSequence("idle");
         var standbyWidth:Number = standby && standby.bounds is Array ?
            Math.max(1,(Number(standby.bounds[2]) - Number(standby.bounds[0]))) : 10;
         var standbyHeight:Number = standby && standby.bounds is Array ?
            Math.max(1,(Number(standby.bounds[3]) - Number(standby.bounds[1]))) : 8;
         var candidatesByFrame:Object = {};
         var frames:Array = _sequence.frames as Array;
         var previousChosen:Object = null;
         var previousChosenFrame:int = -2;
         for(var frameIndex:int = 0; frameIndex < frames.length; frameIndex++)
         {
            var frame:Object = frames[frameIndex];
            var vertices:Array = frame.v is Array ? frame.v : [];
            var regions:Array = frame.r is Array ? frame.r : [];
            var opacities:Array = frame.o is Array ? frame.o : [];
            var subMeshes:Array = frame.s is Array && frame.s.length ? frame.s :
               [[0,int(vertices.length / 8) * 6]];
            var blends:Array = frame.b is Array ? frame.b : [];
            var materials:Array = frameMaterialModes(subMeshes,blends,regions.length);
            var maskDepth:int = 0;
            var malformedMaskStack:Boolean = false;
            var groups:Array = [];
            var active:Array = [];
            for(var subIndex:int = 0; subIndex < subMeshes.length; subIndex++)
            {
               var startQuad:int = int(Math.max(0,Number(subMeshes[subIndex][0])) / 4);
               var quadCount:int = int(Math.max(0,Number(subMeshes[subIndex][1])) / 6);
               var mode:int = subIndex < blends.length ? int(blends[subIndex]) : 0;
               if(mode == 16)
               {
                  if(maskDepth >= 7)
                  {
                     malformedMaskStack = true;
                     break;
                  }
                  maskDepth++;
                  active[maskDepth] = { start:startQuad, maskQuads:[], content:[], quads:[] };
                  appendQuadRange(active[maskDepth].maskQuads,startQuad,quadCount);
                  appendQuadRange(active[maskDepth].quads,startQuad,quadCount);
                  continue;
               }
               if(mode == 32)
               {
                  if(maskDepth <= 0 || active[maskDepth] == null)
                  {
                     malformedMaskStack = true;
                     break;
                  }
                  if(active[maskDepth] != null) groups.push(active[maskDepth]);
                  active[maskDepth] = null;
                  maskDepth = Math.max(0,maskDepth - 1);
                  continue;
               }
               var contentDepth:int = mode >= 80 ?
                  Math.max(1,int((mode - 64) / 16)) : 0;
               if(contentDepth > 0 && contentDepth < active.length && active[contentDepth] != null)
               {
                  appendQuadRange(active[contentDepth].quads,startQuad,quadCount);
                  appendQuadRange(active[contentDepth].content,startQuad,quadCount);
               }
               else if(contentDepth > 0)
               {
                  malformedMaskStack = true;
                  break;
               }
            }
            if(maskDepth != 0) malformedMaskStack = true;
            if(malformedMaskStack) continue;
            var maskCandidates:Array = [];
            for each(var group:Object in groups)
            {
               if(!(group.content is Array) || group.content.length < 1) continue;
               var bounds:Object = groupBounds(group.maskQuads,vertices);
               var contentBounds:Object = groupBounds(group.content,vertices);
               if(bounds == null || contentBounds == null || bounds.height <= 0) continue;
               var aspect:Number = bounds.width / bounds.height;
               if(aspect < 1.35 || bounds.width < standbyWidth * 1.8 || bounds.height < standbyHeight * 1.05 ||
                  contentBounds.width < standbyWidth * 1.45 || contentBounds.height < standbyHeight * .9) continue;
               maskCandidates.push({ frame:frameIndex, group:group, bounds:bounds,
                  area:bounds.width * bounds.height,
                  visibleOpacity:maximumOpacity(group.content,opacities) });
            }
            var normalCandidates:Array = [];
            var earlyDrawLimit:int = Math.max(12,int(regions.length * .25));
            for(var quad:int = 0; quad < regions.length && quad <= earlyDrawLimit; quad++)
            {
               if(int(materials[quad] || 0) != 0) continue;
               var normalBounds:Object = groupBounds([quad],vertices);
               if(normalBounds == null || normalBounds.height <= 0) continue;
               var normalAspect:Number = normalBounds.width / normalBounds.height;
               if(normalAspect < 1.2 || normalAspect > 3.5 ||
                  normalBounds.width < standbyWidth * 1.45 ||
                  normalBounds.height < standbyHeight * .95 ||
                  normalBounds.width * normalBounds.height < standbyWidth * standbyHeight * 2) continue;
               normalCandidates.push({ quad:quad, bounds:normalBounds,
                  area:normalBounds.width * normalBounds.height,
                  visibleOpacity:quad < opacities.length ? int(opacities[quad]) : 255 });
            }
            maskCandidates.sortOn("area",Array.NUMERIC | Array.DESCENDING);
            normalCandidates.sortOn("area",Array.NUMERIC | Array.DESCENDING);
            var chosen:Object = maskCandidates.length ? maskCandidates[0] : null;
            if(maskCandidates.length && previousChosen != null && previousChosenFrame == frameIndex - 1)
            {
               var bestMask:Object = null;
               var bestMaskContinuity:Number = 0;
               for each(var maskCandidate:Object in maskCandidates)
               {
                  var maskContinuity:Number = boundsOverlapRatio(previousChosen.bounds,maskCandidate.bounds);
                  if(maskContinuity > bestMaskContinuity)
                  {
                     bestMask = maskCandidate;
                     bestMaskContinuity = maskContinuity;
                  }
               }
               if(bestMask != null && bestMaskContinuity >= .2) chosen = bestMask;
            }
            if(chosen == null && normalCandidates.length)
            {
               var normalSeed:Object = normalCandidates[0];
               if(previousChosen != null && previousChosenFrame == frameIndex - 1)
               {
                  var bestNormalContinuity:Number = 0;
                  for each(var normalChoice:Object in normalCandidates)
                  {
                     var normalContinuity:Number = boundsOverlapRatio(previousChosen.bounds,normalChoice.bounds);
                     if(normalContinuity > bestNormalContinuity)
                     {
                        normalSeed = normalChoice;
                        bestNormalContinuity = normalContinuity;
                     }
                  }
               }
               chosen = { frame:frameIndex,
                  group:{ maskQuads:[], content:[normalSeed.quad], quads:[normalSeed.quad] },
                  bounds:normalSeed.bounds, area:normalSeed.area,
                  visibleOpacity:normalSeed.visibleOpacity };
            }
            if(chosen != null)
            {
               if(maskCandidates.length)
               {
                  for each(var relatedMask:Object in maskCandidates)
                  {
                     if(relatedMask === chosen || boundsOverlapRatio(chosen.bounds,relatedMask.bounds) < .35)
                        continue;
                     appendUniqueQuads(chosen.group.quads,relatedMask.group.quads);
                     chosen.visibleOpacity = Math.max(int(chosen.visibleOpacity),int(relatedMask.visibleOpacity));
                  }
               }
               // Keep ordinary authored background passes in the same in-place
               // transform when they geometrically overlap the selected mask or
               // normal seed.  This avoids leaving an original-size frame behind
               // the enlarged masked content while still excluding distant model
               // particles and body quads.
               for each(var normal:Object in normalCandidates)
               {
                  if(boundsOverlapRatio(chosen.bounds,normal.bounds) < .35) continue;
                  appendUniqueQuads(chosen.group.quads,[int(normal.quad)]);
                  chosen.visibleOpacity = Math.max(int(chosen.visibleOpacity),int(normal.visibleOpacity));
               }
               candidatesByFrame[String(frameIndex)] = chosen;
               previousChosen = chosen;
               previousChosenFrame = frameIndex;
            }
         }
         var run:Array = [];
         for(frameIndex = 0; frameIndex <= frames.length; frameIndex++)
         {
            var candidate:Object = candidatesByFrame[String(frameIndex)];
            if(candidate != null)
            {
               if(run.length && boundsOverlapRatio(run[run.length - 1].bounds,candidate.bounds) < .2)
               {
                  if(run.length >= 3 && runHasVisibleSeed(run)) registerInternalBackgroundRun(run);
                  run = [];
               }
               run.push(candidate);
               continue;
            }
            if(run.length >= 3 && runHasVisibleSeed(run)) registerInternalBackgroundRun(run);
            run = [];
         }
         cacheInternalBackgroundContract(cacheKey);
      }

      private function actionMustRemainModelLocal():Boolean
      {
         var resolvedName:String = String(_sequence && _sequence.name || _actionName).toLowerCase();
         return ["standby","idle","hited","hit","hurt","appear","win","lose","dead","walk","run"]
            .indexOf(resolvedName) >= 0;
      }

      private function actionUsesEventVideo():Boolean
      {
         var frames:Array = _sequence && _sequence.frames is Array ? _sequence.frames as Array : [];
         for each(var frame:Object in frames)
         {
            var labels:Array = frame && frame.l is Array ? frame.l as Array : [];
            for each(var label:* in labels)
               if(String(label || "").toLowerCase().indexOf("event_video_") == 0) return true;
         }
         var records:Array = _data && _data.eventVideos is Array ? _data.eventVideos as Array : [];
         for each(var record:Object in records)
         {
            var triggers:Array = record && record.triggers is Array ? record.triggers as Array : [];
            for each(var trigger:Object in triggers)
               if(trigger != null && String(trigger.action || "").toLowerCase() == _actionName) return true;
         }
         return false;
      }

      private function cacheInternalBackgroundContract(key:String):void
      {
         _internalContractsByAction[key] = {
            lookup:_internalGroupLookup, transforms:_internalGroupTransforms,
            frameCount:_internalBackgroundFrameCount, groupCount:_internalBackgroundGroupCount
         };
      }

      private function frameMaterialModes(subMeshes:Array,blends:Array,quadCount:int):Array
      {
         var output:Array = new Array(quadCount);
         for(var index:int = 0; index < subMeshes.length; index++)
         {
            var start:int = int(Math.max(0,Number(subMeshes[index][0])) / 4);
            var count:int = int(Math.max(0,Number(subMeshes[index][1])) / 6);
            var mode:int = index < blends.length ? int(blends[index]) : 0;
            for(var offset:int = 0; offset < count; offset++) output[start + offset] = mode;
         }
         return output;
      }

      private function appendQuadRange(output:Array,start:int,count:int):void
      {
         for(var offset:int = 0; offset < count; offset++) output.push(start + offset);
      }

      private function appendUniqueQuads(output:Array,input:Array):void
      {
         for each(var quad:int in input)
            if(output.indexOf(quad) < 0) output.push(quad);
      }

      private function maximumOpacity(quads:Array,opacities:Array):int
      {
         var maximum:int = 0;
         for each(var quad:int in quads)
            maximum = Math.max(maximum,quad < opacities.length ? int(opacities[quad]) : 255);
         return maximum;
      }

      private function runHasVisibleSeed(run:Array):Boolean
      {
         var consecutiveVisibleFrames:int = 0;
         for each(var candidate:Object in run)
         {
            if(int(candidate.visibleOpacity || 0) >= 64) consecutiveVisibleFrames++;
            else consecutiveVisibleFrames = 0;
            if(consecutiveVisibleFrames >= 3) return true;
         }
         return false;
      }

      private function boundsOverlapRatio(first:Object,second:Object):Number
      {
         var width:Number = Math.max(0,Math.min(Number(first.right),Number(second.right)) -
            Math.max(Number(first.left),Number(second.left)));
         var height:Number = Math.max(0,Math.min(Number(first.bottom),Number(second.bottom)) -
            Math.max(Number(first.top),Number(second.top)));
         var smaller:Number = Math.min(Number(first.width) * Number(first.height),
            Number(second.width) * Number(second.height));
         return smaller > 0 ? width * height / smaller : 0;
      }

      private function registerInternalBackgroundRun(run:Array):void
      {
         for each(var candidate:Object in run)
         {
            var key:String = String(candidate.frame) + "|" + String(_internalBackgroundGroupCount++);
            var contract:Object = { key:key, bounds:candidate.bounds };
            var groupQuads:Array = candidate.group.quads as Array;
            for each(var quad:int in groupQuads)
            {
               var quadKey:String = String(candidate.frame) + "|" + String(quad);
               _internalGroupLookup[quadKey] = true;
               _internalGroupTransforms[quadKey] = contract;
            }
            _internalBackgroundFrameCount++;
         }
      }

      private function groupBounds(quads:Array,vertices:Array):Object
      {
         var left:Number = Number.POSITIVE_INFINITY, top:Number = Number.POSITIVE_INFINITY;
         var right:Number = Number.NEGATIVE_INFINITY, bottom:Number = Number.NEGATIVE_INFINITY;
         for each(var quad:int in quads)
         {
            if(quad * 8 + 7 >= vertices.length) continue;
            for(var vertex:int = 0; vertex < 4; vertex++)
            {
               var x:Number = Number(vertices[quad * 8 + vertex * 2]);
               var y:Number = Number(vertices[quad * 8 + vertex * 2 + 1]);
               left = Math.min(left,x); right = Math.max(right,x);
               top = Math.min(top,y); bottom = Math.max(bottom,y);
            }
         }
         if(!isFinite(left) || !isFinite(top) || right <= left || bottom <= top) return null;
         return { left:left, top:top, right:right, bottom:bottom,
            width:right-left, height:bottom-top, centerX:(left+right)/2, centerY:(top+bottom)/2 };
      }

      /** Resolve the authored source-space group to the current Stage viewport.
       * The returned source-space affine contract is shared by its mask and all
       * content quads.  This compensates for either battle host's model scale,
       * mirroring and placement without moving the action root or creating a
       * second display layer. */
      private function resolveInternalTransform(contract:Object,cache:Object):Object
      {
         if(contract == null || stage == null || contract.bounds == null) return null;
         var key:String = String(contract.key || "");
         if(key && cache.hasOwnProperty(key)) return cache[key];
         var corners:Array = [globalToLocal(new Point(0,0)),
            globalToLocal(new Point(stage.stageWidth,0)),
            globalToLocal(new Point(0,stage.stageHeight)),
            globalToLocal(new Point(stage.stageWidth,stage.stageHeight))];
         var left:Number = Number.POSITIVE_INFINITY, top:Number = Number.POSITIVE_INFINITY;
         var right:Number = Number.NEGATIVE_INFINITY, bottom:Number = Number.NEGATIVE_INFINITY;
         for each(var point:Point in corners)
         {
            left = Math.min(left,point.x); right = Math.max(right,point.x);
            top = Math.min(top,point.y); bottom = Math.max(bottom,point.y);
         }
         var bounds:Object = contract.bounds;
         var sourceWidth:Number = Math.max(1,Number(bounds.width) * _modelScale);
         var sourceHeight:Number = Math.max(1,Number(bounds.height) * _modelScale);
         var scale:Number = Math.max((right - left) / sourceWidth,(bottom - top) / sourceHeight);
         scale = Math.max(1,Math.min(4,scale));
         var localCenterX:Number = (left + right) / 2;
         var localCenterY:Number = (top + bottom) / 2;
         var resolved:Object = {
            scale:scale,
            sourceCenterX:Number(bounds.centerX), sourceCenterY:Number(bounds.centerY),
            targetCenterX:localCenterX / _modelScale + _centerX,
            targetCenterY:_baselineY - localCenterY / _modelScale
         };
         if(key) cache[key] = resolved;
         return resolved;
      }

      private function drawFrame(frame:Object):void
      {
         var frameIndex:int = _sequence && _sequence.frames is Array ?
            Math.max(0,Math.min(_sequence.frames.length - 1,_current - 1)) : 0;
         ensureFramePages(frame,frameIndex);
         var vertices:Array = frame.v is Array ? frame.v : [];
         var regions:Array = frame.r is Array ? frame.r : [];
         var opacities:Array = frame.o is Array ? frame.o : [];
         var subMeshes:Array = frame.s is Array && frame.s.length ? frame.s : [[0,int(vertices.length / 8) * 6]];
         var blends:Array = frame.b is Array ? frame.b : [];
         for each(var previousMask:Shape in _masks) previousMask.graphics.clear();
         var maskDefinitions:Array = [];
         var resolvedInternalTransforms:Object = {};
         var maskDepth:int = 0;
         var masksUsed:int = 0;
         var used:int = 0;
         for(var subIndex:int = 0; subIndex < subMeshes.length; subIndex++)
         {
            var startQuad:int = int(Math.max(0,Number(subMeshes[subIndex][0])) / 4);
            var quadCount:int = int(Math.max(0,Number(subMeshes[subIndex][1])) / 6);
            var materialMode:int = subIndex < blends.length ? int(blends[subIndex]) : 0;
            if(materialMode == 16)
            {
               maskDepth = Math.min(7,maskDepth + 1);
               maskDefinitions[maskDepth] = {
                  start:startQuad, count:quadCount,
                  contract:_internalGroupTransforms[String(frameIndex) + "|" + String(startQuad)]
               };
               continue;
            }
            if(materialMode == 32)
            {
               maskDefinitions[maskDepth] = null;
               maskDepth = Math.max(0,maskDepth - 1);
               continue;
            }
            var maskedLevel:int = materialMode >= 80 ?
               Math.max(1,int((materialMode - 64) / 16)) : 0;
            var shape:Shape = null;
            var runOpacity:int = -1;
            var runPageIndex:int = -1;
            for(var offset:int = 0; offset < quadCount; offset++)
            {
               var quad:int = startQuad + offset;
               if(quad * 8 + 7 >= vertices.length || quad >= regions.length) continue;
               var regionIndex:int = int(regions[quad]);
               if(!_data || !(_data.regions is Array) || regionIndex < 0 || regionIndex >= _data.regions.length) continue;
               var region:Object = _data.regions[regionIndex];
               var pageIndex:int = int(region.page);
               if(pageIndex < 0 || pageIndex >= _pages.length || !(_pages[pageIndex] is BitmapData)) continue;
               var opacity:int = quad < opacities.length ?
                  Math.max(0,Math.min(255,int(opacities[quad]))) : 255;
               if(opacity <= 0) continue;
               // Applying a Flash blend mode or alpha to one Shape containing
               // several overlapping quads is not equivalent to applying it
               // to each authored quad in sequence.  The flattened Shape can
               // turn masked/material passes into transient black or white
               // rectangles.  Only opaque, unmasked, normal material is safe
               // to batch; all other quads retain their authored compositing
               // boundary.  This is resource-agnostic and preserves every
               // logical frame, label and host stage quality setting.
               var safeOpaqueNormalBatch:Boolean = materialMode == 0 &&
                  maskedLevel == 0 && opacity == 255;
               if(shape == null || opacity != runOpacity || pageIndex != runPageIndex || !safeOpaqueNormalBatch)
               {
                  shape = shapeAt(used++);
                  shape.graphics.clear();
                  shape.alpha = opacity / 255;
                  shape.blendMode = blendModeFor(materialMode & 15);
                  // Flash permits one mask DisplayObject to own only one mask
                  // relationship at a time.  Reusing the same mask Shape for
                  // several authored quads silently unmasks the earlier ones,
                  // exposing full-frame black/white material textures.  Give
                  // every compositing Shape its own geometry-equivalent mask.
                  shape.mask = maskedLevel > 0 && maskDefinitions[maskedLevel] != null ?
                     renderMaskAt(masksUsed++,maskDefinitions[maskedLevel],vertices,regions,
                        resolveInternalTransform(maskDefinitions[maskedLevel].contract,
                           resolvedInternalTransforms)) : null;
                  runOpacity = opacity;
                  runPageIndex = pageIndex;
               }
               drawQuad(shape,vertices,quad * 8,BitmapData(_pages[pageIndex]),region,regionIndex,false,
                  resolveInternalTransform(
                     _internalGroupTransforms[String(frameIndex) + "|" + String(quad)],
                     resolvedInternalTransforms));
            }
         }
         while(used < _shapes.length)
         {
            var unused:Shape = Shape(_shapes[used++]);
            unused.alpha = 1;
            unused.blendMode = BlendMode.NORMAL;
            unused.mask = null;
            unused.graphics.clear();
         }
         while(masksUsed < _masks.length)
            Shape(_masks[masksUsed++]).graphics.clear();
      }

      /**
       * Decode only the current authored frame and a small forward window.
       * Pages outside the window receive a logical-frame grace period before
       * disposal, preventing black flashes when an action briefly revisits a
       * page while avoiding whole-model residency in x32 memory.
       */
      private function ensureFramePages(frame:Object,frameIndex:int):void
      {
         if(_residencyFrame == frameIndex) return;
         var pageCount:int = Math.max(_pages.length,_pageFactories.length);
         var required:Array = new Array(pageCount);
         var sequenceFrames:Array = _sequence && _sequence.frames is Array ? _sequence.frames as Array : [];
         if(frame != null) collectRequiredPages(frame,required);
         var start:int = Math.max(0,frameIndex);
         for(var lookAhead:int = 1; lookAhead <= PREFETCH_FRAME_WINDOW; lookAhead++)
         {
            var nextIndex:int = start + lookAhead;
            if(nextIndex >= sequenceFrames.length) break;
            collectRequiredPages(sequenceFrames[nextIndex],required);
         }
         var windowPages:int = 0;
         for(var index:int = 0; index < pageCount; index++)
         {
            if(!required[index]) continue;
            windowPages++;
            _pageGrace[index] = RELEASE_GRACE_FRAMES;
            if(ensurePage(index) == null) _missingPageLoads++;
         }
         _residencyWindowPages = windowPages;
         // The current/prefetched pages were refreshed above. Release only
         // pages whose grace window has expired.
         for(index = 0; index < _pages.length; index++)
         {
            if(required[index] || !(_pages[index] is BitmapData)) continue;
            var grace:int = _pageGrace[index] is Number ? int(_pageGrace[index]) : 0;
            if(grace > 0)
            {
               _pageGrace[index] = grace - 1;
               continue;
            }
            disposePage(index);
         }
         _residencyFrame = frameIndex;
      }

      private function collectRequiredPages(frame:Object, required:Array):void
      {
         if(frame == null || !_data || !(_data.regions is Array)) return;
         var vertices:Array = frame.v is Array ? frame.v : [];
         var regions:Array = frame.r is Array ? frame.r : [];
         var opacities:Array = frame.o is Array ? frame.o : [];
         for(var quad:int = 0; quad < regions.length; quad++)
         {
            if(quad * 8 + 7 >= vertices.length) continue;
            if(quad < opacities.length && int(opacities[quad]) <= 0) continue;
            var regionIndex:int = int(regions[quad]);
            if(regionIndex < 0 || regionIndex >= _data.regions.length) continue;
            var pageIndex:int = int(_data.regions[regionIndex].page);
            if(pageIndex >= 0 && pageIndex < required.length) required[pageIndex] = true;
         }
      }

      private function ensurePage(index:int):BitmapData
      {
         if(index < 0 || index >= _pages.length) return null;
         if(_pages[index] is BitmapData) return BitmapData(_pages[index]);
         if(index >= _pageFactories.length) return null;
         var factory:Class = _pageFactories[index] as Class;
         if(factory == null) return null;
         var bitmap:Bitmap = new factory() as Bitmap;
         if(bitmap == null || bitmap.bitmapData == null) return null;
         var pixels:BitmapData = bitmap.bitmapData;
         _pages[index] = pixels;
         _residentBytes += Number(pixels.width) * Number(pixels.height) * 4;
         _peakResidentBytes = Math.max(_peakResidentBytes,_residentBytes);
         _pageCreates++;
         return pixels;
      }

      private function disposePage(index:int):void
      {
         if(index < 0 || index >= _pages.length || !(_pages[index] is BitmapData)) return;
         var pixels:BitmapData = BitmapData(_pages[index]);
         _residentBytes = Math.max(0,_residentBytes - Number(pixels.width) * Number(pixels.height) * 4);
         try { pixels.dispose(); } catch(error:*) {}
         _pages[index] = null;
         _pageDisposals++;
         if(index < _pageGrace.length) _pageGrace[index] = 0;
      }

      private function releasePagesExcept(required:Array):void
      {
         for(var index:int = 0; index < _pages.length; index++)
         {
            if(required && index < required.length && required[index]) continue;
            disposePage(index);
         }
      }

      private function releaseAllPages():void
      {
         clearDisplayGraphics();
         releasePagesExcept(null);
         _pageGrace = new Array(Math.max(_pages.length,_pageFactories.length));
         _residencyFrame = -1;
         _residencyWindowPages = 0;
      }

      private function clearDisplayGraphics():void
      {
         for each(var shape:Shape in _shapes)
         {
            shape.alpha = 1;
            shape.blendMode = BlendMode.NORMAL;
            shape.mask = null;
            shape.graphics.clear();
         }
         for each(var maskShape:Shape in _masks) maskShape.graphics.clear();
      }

      private function blendModeFor(mode:int):String
      {
         if(mode == 1) return BlendMode.ADD;
         if(mode == 2) return BlendMode.SCREEN;
         if(mode == 3) return BlendMode.MULTIPLY;
         if(mode == 4) return BlendMode.LIGHTEN;
         if(mode == 5) return BlendMode.SUBTRACT;
         if(mode == 6) return BlendMode.HARDLIGHT;
         if(mode == 7) return BlendMode.OVERLAY;
         if(mode == 8) return BlendMode.DARKEN;
         return BlendMode.NORMAL;
      }

      private function renderMaskAt(index:int, definition:Object,
         vertices:Array, regions:Array, transform:Object):Shape
      {
         while(_masks.length <= index)
         {
            var created:Shape = new Shape();
            created.cacheAsBitmap = true;
            _masks.push(created);
            addChild(created);
         }
         var maskShape:Shape = Shape(_masks[index]);
         maskShape.graphics.clear();
         var startQuad:int = int(definition.start || 0);
         var quadCount:int = int(definition.count || 0);
         for(var offset:int = 0; offset < quadCount; offset++)
         {
            var quad:int = startQuad + offset;
            if(quad * 8 + 7 >= vertices.length || quad >= regions.length) continue;
            var regionIndex:int = int(regions[quad]);
            if(!_data || !(_data.regions is Array) || regionIndex < 0 ||
               regionIndex >= _data.regions.length) continue;
            var region:Object = _data.regions[regionIndex];
            var pageIndex:int = int(region.page);
            if(pageIndex < 0 || pageIndex >= _pages.length ||
               !(_pages[pageIndex] is BitmapData)) continue;
            drawQuad(maskShape,vertices,quad * 8,BitmapData(_pages[pageIndex]),region,regionIndex,false,
               transform);
         }
         return maskShape;
      }

      private function shapeAt(index:int):Shape
      {
         while(_shapes.length <= index)
         {
            var shape:Shape = new Shape();
            _shapes.push(shape);
            addChild(shape);
         }
         return Shape(_shapes[index]);
      }

      private function drawQuad(shape:Shape, source:Array, start:int, page:BitmapData,
         region:Object, regionIndex:int, clear:Boolean, transform:Object = null):void
      {
         _quadDrawCalls++;
         _geometryScratchReuses++;
         for(var index:int = 0; index < 4; index++)
         {
            var sourceX:Number = Number(source[start + index * 2]);
            var sourceY:Number = Number(source[start + index * 2 + 1]);
            if(transform != null)
            {
               var localScale:Number = Math.max(1,Number(transform.scale || 1));
               var sourceCenterX:Number = Number(transform.sourceCenterX || 0);
               var sourceCenterY:Number = Number(transform.sourceCenterY || 0);
               var targetCenterX:Number = Number(transform.targetCenterX || 0);
               var targetCenterY:Number = Number(transform.targetCenterY || 0);
               sourceX = targetCenterX + (sourceX - sourceCenterX) * localScale;
               sourceY = targetCenterY + (sourceY - sourceCenterY) * localScale;
            }
            _quadVertices[index * 2] = (sourceX - _centerX) * _modelScale;
            _quadVertices[index * 2 + 1] = -(sourceY - _baselineY) * _modelScale;
         }
         var uv:Vector.<Number> = regionIndex >= 0 && regionIndex < _uvCache.length ?
            _uvCache[regionIndex] as Vector.<Number> : null;
         if(uv == null)
         {
            var left:Number = Number(region.x) / page.width;
            var top:Number = Number(region.y) / page.height;
            var right:Number = (Number(region.x) + Number(region.w)) / page.width;
            var bottom:Number = (Number(region.y) + Number(region.h)) / page.height;
            uv = Vector.<Number>([left,bottom, right,bottom, right,top, left,top]);
            _uvCache[regionIndex] = uv;
            _uvCacheBuilds++;
         }
         if(clear) shape.graphics.clear();
         shape.graphics.beginBitmapFill(page,_identityMatrix,false,true);
         shape.graphics.drawTriangles(_quadVertices,_quadIndices,uv);
         shape.graphics.endFill();
      }
   }
}
