import { computeLocalBoundingBox } from "../utils/auto-box-collider.js";
import { setMatrixWorld } from "../utils/three-utils";

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const ROTATE_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

const getCurrentDataFromLocalBB = (function() {
  const currentPosition = new THREE.Vector3();
  const currentScale = new THREE.Vector3();
  return function getCurrentDataFromLocalBB(object3D, localBox, center, halfExtents, offsetToCenter) {
    object3D.updateMatrices();
    const min = localBox.min;
    const max = localBox.max;
    center
      .addVectors(min, max)
      .multiplyScalar(0.5)
      .applyMatrix4(object3D.matrixWorld);
    currentScale.setFromMatrixScale(object3D.matrixWorld);
    halfExtents
      .subVectors(max, min)
      .multiplyScalar(0.5)
      .multiply(currentScale);
    currentPosition.setFromMatrixPosition(object3D.matrixWorld);
    offsetToCenter.subVectors(center, currentPosition);
  };
})();

const calculateDesiredTargetQuaternion = (function() {
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const rotation = new THREE.Matrix4();
  return function calculateDesiredTargetQuaternion(
    cameraPosition,
    cameraRotation,
    isVR,
    intersectionPoint,
    desiredTargetQuaternion
  ) {
    if (!isVR) {
      back
        .set(0, 0, 1)
        .applyMatrix4(cameraRotation)
        .normalize();
    } else {
      back.subVectors(cameraPosition, intersectionPoint).normalize();
    }
    up.set(0, 1, 0);
    forward.copy(back).multiplyScalar(-1);
    right.crossVectors(forward, up).normalize();
    up.crossVectors(right, forward);
    rotation.makeBasis(right, up, back);
    return desiredTargetQuaternion.setFromRotationMatrix(rotation);
  };
})();

export class PositionAtBorderSystem {
  constructor() {
    this.components = [];
  }
  register(component) {
    this.components.push(component);
  }
  unregister(component) {
    this.components.splice(this.components.indexOf(component), 1);
  }
  tick() {
    for (let i = 0; i < this.components.length; i++) {
      this.components[i].tick2();
    }
  }
}

AFRAME.registerComponent("position-at-border", {
  multiple: true,
  schema: {
    target: { type: "string" },
    isFlat: { default: false },
    animate: { default: true },
    scale: { default: true }
  },

  init() {
    this.ready = false;
    this.tick2 = this.tick2.bind(this);
    this.el.sceneEl.systems["hubs-systems"].positionAtBorderSystem.register(this);
  },

  remove() {
    this.el.sceneEl.systems["hubs-systems"].positionAtBorderSystem.unregister(this);
    if (this.didRegisterWithAnimationSystem) {
      this.el.sceneEl.systems["hubs-systems"].menuAnimationSystem.unregister(this);
    }
  },

  markDirty() {
    this.isTargetBoundingBoxDirty = true;
  },

  tick2: (function() {
    const cameraPosition = new THREE.Vector3();
    const cameraRotation = new THREE.Matrix4();
    const camToCenter = new THREE.Vector3();
    const desiredCenterPoint = new THREE.Vector3();
    const desiredTargetPosition = new THREE.Vector3();
    const desiredTargetQuaternion = new THREE.Quaternion();
    const currentTargetScale = new THREE.Vector3();
    const desiredTargetScale = new THREE.Vector3();
    const desiredTargetTransform = new THREE.Matrix4();
    const centerToBorder = new THREE.Vector3();
    const currentMeshRotation = new THREE.Matrix4();
    const meshForward = new THREE.Vector3();
    const boxCorners = new THREE.Vector3();
    return function tick2() {
      if (this.triedToGetReady && !this.ready) {
        return; // TODO: How to handle not finding a target?
      }
      if (!this.ready) {
        this.triedToGetReady = true;
        this.cam = document.getElementById("viewing-camera").object3D;
        const targetEl = this.el.querySelector(this.data.target);
        if (!targetEl) return;
        if (this.data.animate) {
          this.didRegisterWithAnimationSystem = true;
          this.el.sceneEl.systems["hubs-systems"].menuAnimationSystem.register(this, targetEl, this.data.scale);
        }
        this.target = targetEl.object3D;
        this.wasVisible = false;
        this.previousMesh = null;
        this.meshLocalBoundingBox = new THREE.Box3();
        this.meshCenter = new THREE.Vector3();
        this.meshHalfExtents = new THREE.Vector3();
        this.meshOffsetToCenter = new THREE.Vector3();
        this.isTargetBoundingBoxDirty = true;
        this.targetLocalBoundingBox = new THREE.Box3();
        this.targetCenter = new THREE.Vector3();
        this.targetHalfExtents = new THREE.Vector3();
        this.targetOffsetToCenter = new THREE.Vector3();
        this.ready = true;
      }
      const currentMesh = this.el.getObject3D("mesh");
      if (!currentMesh) {
        return;
      }
      const isVisible = this.target.visible;
      const isOpening = isVisible && !this.wasVisible;
      this.wasVisible = isVisible;
      if (isOpening) {
        if (this.isTargetBoundingBoxDirty) {
          computeLocalBoundingBox(this.target, this.targetLocalBoundingBox, true);
          if (this.targetLocalBoundingBox.min.x === Infinity) {
            return;
          }
          this.isTargetBoundingBoxDirty = false;
        }
        getCurrentDataFromLocalBB(
          this.target,
          this.targetLocalBoundingBox,
          this.targetCenter,
          this.targetHalfExtents,
          this.targetOffsetToCenter
        );
        const isMeshChanged = currentMesh !== this.previousMesh;
        if (isMeshChanged) {
          computeLocalBoundingBox(currentMesh, this.meshLocalBoundingBox, true);
          this.previousMesh = currentMesh;
        }
        getCurrentDataFromLocalBB(
          currentMesh,
          this.meshLocalBoundingBox,
          this.meshCenter,
          this.meshHalfExtents,
          this.meshOffsetToCenter
        );
        currentMeshRotation.extractRotation(currentMesh.matrixWorld);
        meshForward.set(0, 0, -1).applyMatrix4(currentMeshRotation);
        this.cam.updateMatrices();
        cameraPosition.setFromMatrixPosition(this.cam.matrixWorld);
        cameraRotation.extractRotation(this.cam.matrixWorld);
        camToCenter.subVectors(cameraPosition, this.meshCenter);
        const needsYRotate = this.data.isFlat && meshForward.dot(camToCenter) > 0;
        const intersection = this.el.sceneEl.systems.interaction.getActiveIntersection();
        if (this.data.isFlat) {
          desiredCenterPoint.copy(this.meshCenter).add(
            centerToBorder
              .set(0, 0, this.meshHalfExtents.z + this.targetHalfExtents.z + 0.02)
              .multiplyScalar(needsYRotate ? -1 : 1)
              .applyMatrix4(currentMeshRotation)
          );
        } else if (intersection) {
          desiredCenterPoint.copy(intersection.point);
          desiredCenterPoint.lerpVectors(cameraPosition, desiredCenterPoint, 0.8);
        } else {
          const meshSphereRadius =
            boxCorners.subVectors(this.meshHalfExtents.max, this.meshHalfExtents.min).length() / 2;
          camToCenter.normalize().multiplyScalar(meshSphereRadius);
          desiredCenterPoint.copy(this.meshCenter).add(camToCenter);
        }
        if (this.data.scale) {
          camToCenter.subVectors(cameraPosition, desiredCenterPoint); //mutation on purpose
          const distanceToCenter = camToCenter.length();
          desiredTargetScale.setScalar(THREE.Math.clamp(0.45 * distanceToCenter, MIN_SCALE, MAX_SCALE));
        } else {
          desiredTargetScale.setFromMatrixScale(this.target.matrixWorld);
        }
        if (this.data.scale) {
          desiredTargetPosition
            .copy(desiredCenterPoint)
            .sub(
              this.targetOffsetToCenter
                .divide(currentTargetScale.setFromMatrixScale(this.target.matrixWorld))
                .multiply(desiredTargetScale)
            );
        } else {
          //desiredTargetPosition.setFromMatrixPosition(this.target.matrixWorld);
          desiredTargetPosition.copy(this.meshCenter).add(
            centerToBorder
              .set(0, 0, this.meshHalfExtents.z + this.targetHalfExtents.z + 0.02)
              .multiplyScalar(needsYRotate ? -1 : 1)
              .applyMatrix4(currentMeshRotation)
          );
        }
        if (this.data.isFlat) {
          desiredTargetQuaternion.setFromRotationMatrix(currentMeshRotation); //TODO: Rotate 180?
          if (needsYRotate) {
            desiredTargetQuaternion.multiply(ROTATE_Y);
          }
        } else {
          calculateDesiredTargetQuaternion(
            cameraPosition,
            cameraRotation,
            this.el.sceneEl.is("vr-mode"),
            desiredTargetPosition,
            desiredTargetQuaternion
          );
        }
        desiredTargetTransform.compose(
          desiredTargetPosition,
          desiredTargetQuaternion,
          desiredTargetScale
        );
        setMatrixWorld(this.target, desiredTargetTransform);
      }
    };
  })()
});
