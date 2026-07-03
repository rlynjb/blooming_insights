# 03 — Object detection / CV system design

- **The prompt:** "Design a computer vision system that detects objects in real-time video, on-device."

- **Standard architecture:**

```
Video frames
  │
  ▼
┌──────────────────────────────────┐
│ Preprocessing                    │
│  (resize, normalize, batch)      │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ Detection model                  │
│  (CNN or MediaPipe-style         │
│   landmark detector)             │
└──────────────┬───────────────────┘
               │
               │  bounding boxes
               │  or landmarks
               ▼
┌──────────────────────────────────┐
│ Post-processing                  │
│  (smoothing, tracking,           │
│   confidence thresholding)       │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ Downstream consumer              │
│  (rep counter, form classifier,  │
│   AR overlay, etc.)              │
└──────────────┬───────────────────┘
               │
               ▼
            Output
```

- **Data model:**
  - Frame buffer (rolling window, last N frames)
  - Detection output per frame: `{bounding boxes or landmarks, confidence, model version, timestamp}`
  - Tracking state: which detection in frame T corresponds to which in frame T+1 (object identity across time)
  - Inference log (when audit-enabled): raw detections, post-processed outputs, user feedback — the training data pipeline for future model improvements

- **Key components:**
  - *Preprocessing*: resize to model input size, normalize. Decision: do on-device, not cloud, for privacy + latency.
  - *Detection model*: CNN for general object detection (YOLO-style), pose estimation model for landmark detection (MediaPipe-style). Decision: choose model based on output shape needed downstream — boxes vs landmarks.
  - *Post-processing*: smoothing over time (Kalman filter or simple EMA) to reduce jitter, confidence thresholding to drop noisy detections.
  - *Tracking*: maintain object identity across frames so downstream consumers see "the same object moved" not "two new objects appeared."
  - *Downstream consumer*: the trained classifier or rule engine that uses the detections to produce final output (form labels, rep counts, AR placement).

- **Scale concerns:**
  - At ~30fps real-time: per-frame inference must hit < 33ms. Solution: quantization (int8 or fp16), GPU delegate on supported devices, skip frames when behind.
  - On older devices: model too big for memory or too slow. Solution: smaller variant of same model, fallback to per-frame instead of streaming.
  - Battery cost: continuous inference drains battery. Solution: pause inference when user is idle, lower fps when motion is slow.

- **Eval framing:**
  - Offline: mAP (mean Average Precision) on held-out labeled video, per-class precision and recall
  - Online: latency p95/p99 on real devices, battery cost per minute, FPS sustained
  - User-facing: downstream task accuracy (does the rep counter agree with ground truth? does the form classifier work?)
  - Domain gap measurement: train on public dataset, eval on real user devices to catch distribution shift.

- **Common failure modes:**
  - Domain gap: model trained on professional studio video fails on phone-camera-in-living-room video. Mitigation: fine-tune on self-collected data from the actual deployment environment.
  - Occlusion / partial visibility: model reports low confidence or misses entirely. Mitigation: track through occlusion using temporal smoothing, surface uncertainty to downstream consumer.
  - Drift in deployment: lighting, camera angles, user demographics shift over time. Mitigation: drift detection on detection-output distribution, retraining trigger.
  - Battery / thermal throttling: long sessions slow the model. Mitigation: monitor frame time, degrade gracefully (drop fps, skip frames) before the user notices.

- **Applies to this codebase:** **no**. `blooming_insights` is a web app that analyzes ecommerce data via LLM agents. No video, no cameras, no on-device inference, no vision at all. The mechanism library (detection → post-processing → tracking → downstream consumer) doesn't map to anything in this codebase — it's a fundamentally different product shape.

- **How to make it apply:** it wouldn't. The retrofit would require inventing a different product entirely (a Bloomreach mobile app that uses camera input for in-store engagement, or something equally divergent). Not a real project. Interview answer: "this template doesn't apply — my codebase is a web-based LLM app, not a CV product. I know the canonical architecture (preprocessing → CNN/landmark → post-processing → tracking → consumer) from curriculum work; walking through it as an interview thought experiment would be fine, but I wouldn't force a mapping to `blooming_insights` where none exists."
