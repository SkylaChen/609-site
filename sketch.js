// Week 9 — FaceMesh + your PSD artwork
// manifest.json keeps each PNG's size and position on the original PSD canvas.

let video;
let faceMesh;
let faces = [];
let modelReady = false;
let loadError = false;
let artError = false;
let artwork;
let avatarImages = {};
let pupilBuffer;
let gaze = { x: 0, y: 0 };

const quality = new URLSearchParams(window.location.search).get("quality");
const LIGHT_MODE = quality === "lite" || (quality !== "full" && window.matchMedia("(pointer: coarse)").matches);
const ART_PATH = LIGHT_MODE ? "assets/avatar-lite/" : "assets/avatar-half/";
const RENDER_SCALE = LIGHT_MODE ? 0.25 : 0.5;
let pupilCache = { x: null, y: null };
const MIRROR_TRACKING = true;
const EYE_CLOSED_THRESHOLD = 0.22; // Near-closed landmark gap, relative to open eyes.
const EYE_HALF_THRESHOLD = 0.50;
let eyeBaseline = null;
let eyeSamples = [];
function resetEyesCalibration() {
  eyeBaseline = null;
  eyeSamples = [];
  avatar.eyeOpen = 1;
}
let browBaseline = null;
let browSamples = [];
let browExpression = "browsNeutral";
let browCandidate = "browsNeutral";
let browCandidateFrames = 0;
let browCalibrating = true;
let browCalibrationStart = null;
function resetBrowCalibration() {
  browCalibrating = true;
  browCalibrationStart = null;
  browBaseline = null;
  browSamples = [];
  browExpression = "browsNeutral";
  browCandidate = "browsNeutral";
  browCandidateFrames = 0;
}

// Measure a neutral, closed mouth for each person instead of assuming one shape.
let mouthBaseline = null;
let mouthSamples = [];
let mouthUpdateTime = null;
let mouthCandidate = "mouthClosed";
let mouthCandidateSince = 0;
function resetMouthCalibration() {
  mouthUpdateTime = null;
  mouthCandidate = "mouthClosed";
  mouthCandidateSince = 0;
  mouthBaseline = null;
  mouthSamples = [];
  avatar.mouthOpen = 0;
  avatar.smiling = false;
  avatar.mouthLayer = "mouthClosed";
}
function keyPressed() {
  if (key === "e" || key === "E") resetEyesCalibration();
  if (key === "m" || key === "M") resetMouthCalibration();
  if (key === "b" || key === "B") resetBrowCalibration();
  if (key === "c" || key === "C") {
    resetMouthCalibration();
    resetBrowCalibration();
    resetEyesCalibration();
  }
}

let avatar = {
  x: 480,
  y: 259.2,
  scale: 1,
  angle: 0,
  eyeOpen: 1,
  mouthOpen: 0,
  smiling: false,
  mouthWidth: 1,
  mouthLayer: "mouthClosed"
};

async function setup() {
  pixelDensity(1);
  frameRate(LIGHT_MODE ? 30 : 60);
  const canvas = createCanvas(650, 714);
  // Render at half resolution; CSS fits the display to the screen.
  canvas.parent("avatar-stage");
  textAlign(CENTER, CENTER);
  textFont("Arial");

  try {
    artwork = await loadJSON(ART_PATH + "manifest.json");
    if (artwork.ready === false) {
      canvas.hide();
      noLoop();
      return;
    }
    resizeCanvas(Math.round(artwork.canvas.width * RENDER_SCALE),
      Math.round(artwork.canvas.height * RENDER_SCALE));
    avatar.x = artwork.anchor.x;
    avatar.y = artwork.anchor.y;
    // Decode one image at a time to reduce peak memory on phones.
    for (const [name, layer] of Object.entries(artwork.layers)) {
      avatarImages[name] = await loadImage(ART_PATH + layer.file);
    }
    const eye = artwork.layers.eyeWhite;
    pupilBuffer = createGraphics(Math.ceil(eye.width * RENDER_SCALE), Math.ceil(eye.height * RENDER_SCALE));
    pupilBuffer.pixelDensity(1);
    document.getElementById("project-status").hidden = true;
  } catch (error) {
    const status = document.getElementById("project-status");
    status.hidden = false;
    status.textContent = "素材加载失败：" + error.message;
    console.error("Could not load avatar artwork:", error);
    artError = true;
    return;
  }

  const startButton = document.getElementById("start-tracking");
  if (LIGHT_MODE) {
    startButton.hidden = false;
    setTrackingStatus("角色已加载，请点击启动人脸追踪");
  } else {
    startCameraTracking();
  }
}

let trackingStarting = false;
function setTrackingStatus(message) {
  const status = document.getElementById("tracking-status");
  if (status) { status.hidden = !message; status.textContent = message; }
}
async function startCameraTracking() {
  if (trackingStarting || modelReady) return;
  trackingStarting = true;
  const button = document.getElementById("start-tracking");
  button.disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("请通过 HTTPS 链接，在 Safari 或 Chrome 中打开页面");
    }
    setTrackingStatus("请允许摄像头访问…");
    if (video) {
      for (const track of video.elt.srcObject?.getTracks() || []) track.stop();
      video.remove();
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: {ideal: LIGHT_MODE ? 320 : 640},
        height: {ideal: LIGHT_MODE ? 240 : 480}, frameRate: {ideal: 24, max: 30} },
      audio: false
    });
    video = createVideo([]);
    video.hide();
    video.elt.playsInline = true;
    video.elt.setAttribute("playsinline", "");
    video.elt.muted = true;
    video.elt.srcObject = stream;
    await video.elt.play();
    if (video.elt.readyState < 2) {
      await new Promise(resolve => video.elt.addEventListener("loadeddata", resolve, {once:true}));
    }
    video.size(video.elt.videoWidth, video.elt.videoHeight);
    setTrackingStatus("摄像头已就绪，正在加载人脸模型，首次需要稍等…");
    await startFaceTracking();
    button.hidden = true;
    setTrackingStatus("");
  } catch (error) {
    const reasons = {
      NotAllowedError: "摄像头未获允许。请在浏览器网站设置中允许摄像头，再重试。",
      NotFoundError: "没有找到可用摄像头。",
      NotReadableError: "摄像头被其他应用占用，请关闭后重试。"
    };
    setTrackingStatus(reasons[error.name] || "追踪启动失败：" + error.message);
    button.textContent = "重试人脸追踪";
    button.hidden = false;
    console.error("Tracking startup failed:", error);
  } finally {
    trackingStarting = false;
    button.disabled = false;
  }
}

async function startFaceTracking() {
  try {
    if (LIGHT_MODE) await ml5.setBackend("webgl");
    faceMesh = await ml5.faceMesh({ maxFaces: 1, refineLandmarks: !LIGHT_MODE });
    faceMesh.detectStart(video, gotFaces);
    modelReady = true;
    loadError = false;
  } catch (error) {
    console.error("Could not load FaceMesh:", error);
    loadError = true;
    throw error;
  }
}

function gotFaces(results) {
  faces = results;
  const points = results[0]?.keypoints;
  if (points && points.length >= 468) {
    updateEyes(points);
    updateBrows(points);
    updateGaze(points);
    updateMouth(points);
  }
}

function draw() {
  background(248, 246, 250);

  if (artError) {
    drawMessage("609: artwork could not load. Check assets/avatar-half/.");
    return;
  }
  if (!artwork || !avatarImages.frontHair) {
    drawMessage("Loading your artwork...");
    return;
  }

  const points = faces[0]?.keypoints;
  if (points && points.length >= 468) updateAvatar(points);

  // Keep the portrait visible while the model loads or the face leaves the camera.
  drawAvatar();
  drawStatus();
}

function updateAvatar(points) {
  const bounds = getFaceBounds(points);
  const eyeLineAngle = atan2(
    points[263].y - points[33].y,
    points[263].x - points[33].x
  );

  const cameraX = MIRROR_TRACKING ? video.width - bounds.centerX : bounds.centerX;
  const targetX = artwork.anchor.x + (cameraX / video.width - 0.5) * artwork.canvas.width * 0.35;
  const targetY = artwork.anchor.y + (bounds.centerY / video.height - 0.5) * artwork.canvas.height * 0.25;
  const targetAngle = MIRROR_TRACKING ? -eyeLineAngle : eyeLineAngle;
  const targetScale = constrain((bounds.width * 640 / video.width) / 190, 0.9, 1.12);

  avatar.x = lerp(avatar.x, targetX, 0.2);
  avatar.y = lerp(avatar.y, targetY, 0.2);
  avatar.scale = lerp(avatar.scale, targetScale, 0.2);
  avatar.angle = lerp(avatar.angle, constrain(targetAngle, -0.35, 0.35), 0.2);

}

// Run once per new camera inference, not once per canvas redraw.
function updateMouth(points) {
  const mouthRatio = getMouthOpenRatio(points);
  const smile = getSmileMetrics(points);
  if (!mouthBaseline) {
    mouthSamples.push({ open: mouthRatio, lift: smile.lift, width: smile.width });
    if (mouthSamples.length >= 30) {
      const median = field => {
        const values = mouthSamples.map(sample => sample[field]).sort((a, b) => a - b);
        return (values[14] + values[15]) / 2;
      };
      mouthBaseline = { open: median("open"), lift: median("lift"), width: median("width") };
    }
    avatar.mouthOpen = 0;
    avatar.smiling = false;
    avatar.mouthLayer = "mouthClosed";
    return;
  }
  const opening = Math.max(0, mouthRatio - mouthBaseline.open);
  const now = millis();
  const dt = mouthUpdateTime === null ? 33 : Math.max(1, now - mouthUpdateTime);
  mouthUpdateTime = now;
  // Strong articulation reacts fast; small landmark noise is smoothed more.
  const change = Math.abs(opening - avatar.mouthOpen);
  const timeConstant = change > 0.04 ? 18 : 40;
  const alpha = 1 - Math.exp(-dt / timeConstant);
  avatar.mouthOpen += (opening - avatar.mouthOpen) * alpha;
  const lift = smile.lift - mouthBaseline.lift;
  const widening = smile.width / Math.max(mouthBaseline.width, 0.01);
  // A slight corner lift and widening can identify a closed-lip smile.
  const smilingNow = avatar.smiling
    ? lift > 0.004 && widening > 1.01
    : lift > 0.008 && widening > 1.025;
  avatar.smiling = smilingNow;
  avatar.mouthWidth = widening;
  const candidate = classifyMouth(
    avatar.mouthOpen, widening, avatar.smiling, avatar.mouthLayer
  );
  // Confirm tiny boundary changes for 35 ms; clear opening/closing moves switch immediately.
  const immediate = opening < 0.012 || change > 0.055;
  avatar.mouthLayer = stabilizeMouth(candidate, now, immediate);
  const label = document.getElementById("mouth-state");
  if (label) label.textContent = "嘴型：" + {
    mouthClosed:"闭嘴", mouthRelaxed:"抿嘴笑", mouthParted:"微张",
    mouthOpen:"露齿笑", mouthWide:"张嘴", mouthRound:"圆嘴"
  }[avatar.mouthLayer];
}

function getFaceBounds(points) {
  let minX = video.width;
  let maxX = 0;
  let minY = video.height;
  let maxY = 0;

  for (const point of points) {
    minX = min(minX, point.x);
    maxX = max(maxX, point.x);
    minY = min(minY, point.y);
    maxY = max(maxY, point.y);
  }

  return {
    width: maxX - minX,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

// 1 = open, 0.5 = eyelid more than halfway down, 0 = near fully closed.
function classifyEyes(openness, previous) {
  const closedLimit = previous === 0 ? 0.26 : EYE_CLOSED_THRESHOLD;
  if (openness <= closedLimit) return 0;
  // A narrow 50–52% band avoids flickering at the halfway boundary.
  const halfLimit = previous === 0.5 ? 0.52 : EYE_HALF_THRESHOLD;
  return openness < halfLimit ? 0.5 : 1;
}
function updateEyes(points) {
  const ratio = getEyeOpenRatio(points);
  if (!Number.isFinite(ratio) || ratio < 0) return;
  if (eyeSamples.length < 20 && ratio > 0) {
    eyeSamples.push(ratio);
    const sorted = [...eyeSamples].sort((a, b) => a - b);
    eyeBaseline = sorted[Math.floor((sorted.length - 1) * 0.8)];
  }
  if (!eyeBaseline) return;
  const openness = ratio / Math.max(eyeBaseline, 0.01);
  // No blink timer: reopening immediately releases the closed-eye drawing.
  avatar.eyeOpen = classifyEyes(openness, avatar.eyeOpen);
}

function getEyeOpenRatio(points) {
  const leftHeight = dist(points[159].x, points[159].y, points[145].x, points[145].y);
  const leftWidth = dist(points[33].x, points[33].y, points[133].x, points[133].y);
  const rightHeight = dist(points[386].x, points[386].y, points[374].x, points[374].y);
  const rightWidth = dist(points[263].x, points[263].y, points[362].x, points[362].y);
  return (leftHeight / leftWidth + rightHeight / rightWidth) / 2;
}

function getMouthOpenRatio(points) {
  const mouthHeight = dist(points[13].x, points[13].y, points[14].x, points[14].y);
  const mouthWidth = dist(points[61].x, points[61].y, points[291].x, points[291].y);
  return mouthHeight / Math.max(mouthWidth, 1);
}

function getSmileMetrics(points) {
  const left = points[61];
  const right = points[291];
  const upper = points[13];
  const lower = points[14];
  const mouthWidth = Math.max(Math.hypot(right.x - left.x, right.y - left.y), 1);
  const eyeWidth = Math.max(Math.hypot(
    points[263].x - points[33].x, points[263].y - points[33].y
  ), 1);
  // Project onto the face's vertical axis so a head tilt isn't read as a smile.
  let normalX = -(right.y - left.y) / mouthWidth;
  let normalY = (right.x - left.x) / mouthWidth;
  const forehead = points[10];
  const chin = points[152];
  if (normalX * (chin.x - forehead.x) + normalY * (chin.y - forehead.y) < 0) {
    normalX = -normalX;
    normalY = -normalY;
  }
  const offsetX = (upper.x + lower.x - left.x - right.x) / 2;
  const offsetY = (upper.y + lower.y - left.y - right.y) / 2;
  return {
    lift: (offsetX * normalX + offsetY * normalY) / mouthWidth,
    width: mouthWidth / eyeWidth
  };
}

// Lip geometry approximates toothy smiles; the model does not directly detect teeth.
function classifyMouth(opening, widening, smiling, previous) {
  const isRound = opening > (previous === "mouthRound" ? 0.065 : 0.095)
    && widening < (previous === "mouthRound" ? 1.035 : 0.985);
  const tallRound = opening > (previous === "mouthRound" ? 0.26 : 0.32)
    && widening < 1.09;
  if (isRound || tallRound) return "mouthRound";
  const closedLimit = ["mouthClosed", "mouthRelaxed"].includes(previous) ? 0.022 : 0.014;
  if (opening < closedLimit) return smiling ? "mouthRelaxed" : "mouthClosed";
  const wideLimit = previous === "mouthWide" ? 0.115 : 0.155;
  if (opening > wideLimit) return "mouthWide";
  const toothyLimit = previous === "mouthOpen" ? 0.032 : 0.048;
  if (smiling && opening > toothyLimit) return "mouthOpen";
  // Small speech openings have their own image, rather than the toothy smile.
  if (!smiling && widening > 1.08 && opening > 0.075) return "mouthWide";
  return "mouthParted";
}

function stabilizeMouth(candidate, now, immediate = false) {
  if (candidate === avatar.mouthLayer) {
    mouthCandidate = candidate;
    mouthCandidateSince = now;
    return avatar.mouthLayer;
  }
  if (candidate !== mouthCandidate) {
    mouthCandidate = candidate;
    mouthCandidateSince = now;
  }
  return immediate || now - mouthCandidateSince >= 35 ? candidate : avatar.mouthLayer;
}

function getMouthLayer() {
  return avatar.mouthLayer;
}

function drawAvatar() {
  push();
  // Keep original PSD coordinates while drawing into the smaller canvas.
  scale(RENDER_SCALE);
  translate(avatar.x, avatar.y);
  // Apply camera-distance zoom after resolution scaling.
  scale(avatar.scale);
  translate(-artwork.anchor.x, -artwork.anchor.y);

  drawArtLayer("backHair", true);
  drawArtLayer("neck");
  drawArtLayer("body");
  drawArtLayer("bodyLines");
  drawArtLayer("face", true);

  const eyes = avatar.eyeOpen < 0.22 ? "eyesClosed"
    : avatar.eyeOpen < 0.75 ? "eyesHalf" : "eyesOpen";
  if (eyes !== "eyesClosed") drawPupils();
  drawArtLayer(eyes, true);

  drawArtLayer(getMouthLayer(), true);

  drawArtLayer("frontHair", true);
  drawArtLayer(browExpression, true);
  pop();
}

function drawArtLayer(name, followsHead = false) {
  const layer = artwork.layers[name];
  push();
  if (followsHead) {
    const pivot = artwork.headPivot;
    translate(pivot.x, pivot.y);
    rotate(avatar.angle);
    translate(-pivot.x, -pivot.y);
  }
  // All hair uses the same head angle. No inertia is applied.
  image(avatarImages[name], layer.x, layer.y, layer.width, layer.height);
  pop();
}

function drawMessage(message) {
  fill(77, 70, 88);
  noStroke();
  textSize(14);
  text(message, width / 2, height / 2);
}

function drawStatus() {
  let message = "Face tracking active";
  if (loadError) message = "FaceMesh could not load. Check the browser console.";
  else if (!modelReady) message = "Loading FaceMesh...";
  else if (!faces[0]?.keypoints) message = "Show your face to the camera.";
  else if (!browBaseline) message = "Relax your eyebrows to calibrate... (B: recalibrate brows)";
  else if (!mouthBaseline) message = "Calibrating: eyes open, brows relaxed, eyes open, lips closed...";
  else message = "Face tracking active — C: recalibrate face / B: recalibrate relaxed eyebrows.";

  noStroke();
  fill(248, 246, 250, 230);
  rect(0, height - 27, width, 27);
  fill(77, 70, 88);
  textSize(12);
  text(message, width / 2, height - 14);
}


function updateGaze(points) {
  // Refined FaceMesh includes iris centers. Fall back to a centered gaze.
  if (points.length < 478) { gaze.x = 0; gaze.y = 0; return; }
  const readings = [[468,33,133,159,145], [473,362,263,386,374]].map(ids => {
    const [iris, a, b, top, bottom] = ids.map(id => points[id]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const span = Math.max(Math.hypot(dx, dy), 1);
    const ux = dx / span, uy = dy / span;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const eyeHeight = Math.max(Math.hypot(top.x - bottom.x, top.y - bottom.y), 1);
    return {
      x: ((iris.x - cx) * ux + (iris.y - cy) * uy) / span,
      y: ((iris.x - (top.x + bottom.x) / 2) * -uy
        + (iris.y - (top.y + bottom.y) / 2) * ux) / eyeHeight
    };
  });
  const horizontal = (readings[0].x + readings[1].x) / 2;
  const vertical = (readings[0].y + readings[1].y) / 2;
  gaze.x = lerp(gaze.x, constrain(horizontal * (MIRROR_TRACKING ? -120 : 120), -24, 24), 0.45);
  gaze.y = lerp(gaze.y, constrain(vertical * 16, -12, 12), 0.45);
}

function drawPupils() {
  const white = artwork.layers.eyeWhite;
  const pupils = artwork.layers.pupils;
  drawArtLayer("eyeWhite", true);
  // Only rebuild the small iris surface when the gaze actually changes.
  if (pupilCache.x !== gaze.x || pupilCache.y !== gaze.y) {
    pupilBuffer.clear();
    pupilBuffer.push();
    pupilBuffer.scale(RENDER_SCALE);
    pupilBuffer.image(avatarImages.pupils,
      pupils.x - white.x + gaze.x, pupils.y - white.y + gaze.y,
      pupils.width, pupils.height);
    pupilBuffer.drawingContext.globalCompositeOperation = "destination-in";
    pupilBuffer.image(avatarImages.eyeWhite, 0, 0, white.width, white.height);
    pupilBuffer.drawingContext.globalCompositeOperation = "source-over";
    pupilBuffer.pop();
    pupilCache = { x: gaze.x, y: gaze.y };
  }
  push();
  translate(artwork.headPivot.x, artwork.headPivot.y);
  rotate(avatar.angle);
  translate(-artwork.headPivot.x, -artwork.headPivot.y);
  image(pupilBuffer, white.x, white.y, white.width, white.height);
  pop();
}


function getBrowMetrics(points) {
  const left = points[33], right = points[263];
  const dx = right.x - left.x, dy = right.y - left.y;
  const span = Math.max(Math.hypot(dx, dy), 1);
  let nx = -dy / span, ny = dx / span;
  if (nx * (points[152].x - points[10].x) + ny * (points[152].y - points[10].y) < 0) {
    nx = -nx; ny = -ny;
  }
  const vertical = (a, b) => (a.x - b.x) * nx + (a.y - b.y) * ny;
  const distance = (a, b) => Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
  const leftSpan = distance(points[33], points[133]);
  const rightSpan = distance(points[362], points[263]);
  return {
    // Eye corners remain stable when the eyelids close.
    height: (vertical({x:(points[33].x+points[133].x)/2, y:(points[33].y+points[133].y)/2}, points[105]) / leftSpan
      + vertical({x:(points[362].x+points[263].x)/2, y:(points[362].y+points[263].y)/2}, points[334]) / rightSpan) / 2,
    innerGap: distance(points[107], points[336]) / span,
    innerLeft: vertical(points[70], points[107]) / leftSpan,
    innerRight: vertical(points[300], points[336]) / rightSpan,
    innerLift: (vertical(points[70], points[107]) / leftSpan
      + vertical(points[300], points[336]) / rightSpan) / 2
  };
}
function classifyBrows(height, contraction, previous) {
  if (height > (previous === "browsRaised" ? 0.020 : 0.035)) return "browsRaised";
  // A frown needs BOTH lowering and inward contraction, not either one alone.
  const lowering = previous === "browsSad" ? -0.030 : -0.050;
  const tightening = previous === "browsSad" ? 0.018 : 0.030;
  if (height < lowering && contraction > tightening) return "browsSad";
  return "browsNeutral";
}

function updateBrows(points) {
  const label = document.getElementById("brow-state");
  const metrics = getBrowMetrics(points);
  if (!Number.isFinite(metrics.height) || !Number.isFinite(metrics.innerGap)) return;
  if (!browBaseline) {
    browExpression = "browsNeutral";
    if (!browCalibrating) {
      if (label) label.textContent = "先放松眉毛，再点校准";
      return;
    }
    if (browCalibrationStart === null) browCalibrationStart = millis();
    browSamples.push(metrics);
    if (label) label.textContent = "校准中，请保持眉毛放松…";
    if (millis() - browCalibrationStart >= 1500 && browSamples.length >= 15) {
      const median = field => {
        const values = browSamples.map(sample => sample[field]).sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid-1] + values[mid]) / 2;
      };
      browBaseline = { height: median("height"), innerGap: median("innerGap") };
      browCalibrating = false;
      if (label) label.textContent = "校准完成 · 正常";
    }
    return;
  }
  const candidate = classifyBrows(
    metrics.height - browBaseline.height,
    browBaseline.innerGap - metrics.innerGap,
    browExpression
  );
  if (candidate === browCandidate) browCandidateFrames++;
  else { browCandidate = candidate; browCandidateFrames = 1; }
  const requiredFrames = candidate === "browsSad" ? 3 : 2;
  if (candidate === "browsNeutral" || browCandidateFrames >= requiredFrames) browExpression = candidate;
  if (label) label.textContent = {browsNeutral:"正常", browsRaised:"挑眉", browsSad:"皱眉 → 委屈"}[browExpression];
}
