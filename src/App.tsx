import { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 48.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 48; 
// 修改：将 top.jpg 加入到数组开头
const bodyPhotoPaths = [
  'photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `photos/${i + 1}.jpg`)
];

// --- 视觉配置 ---
const CONFIG = {
  colors: {
    emerald: '#004225', // 纯正祖母绿
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#D32F2F',
    green: '#2E7D32',
    white: '#FFFFFF',   // 纯白色
    warmLight: '#FFD54F',
    lights: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'], // 彩灯
    // 拍立得边框颜色池 (复古柔和色系)
    borders: ['#FFFAF0', '#F0E68C', '#E6E6FA', '#FFB6C1', '#98FB98', '#87CEFA', '#FFDAB9'],
    // 圣诞元素颜色
    giftColors: ['#D32F2F', '#FFD700', '#1976D2', '#2E7D32'],
    candyColors: ['#FF0000', '#FFFFFF']
  },
  counts: {
    foliage: 15000,
    ornaments: 300,   // 拍立得照片数量
    elements: 200,    // 圣诞元素数量
    lights: 400       // 彩灯数量
  },
  tree: { height: 22, radius: 9 }, // 树体尺寸
  photos: {
    // top 属性不再需要，因为已经移入 body
    body: bodyPhotoPaths
  }
};

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
        <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

const SCENE_GROUP_OFFSET = new THREE.Vector3(0, -6, 0); 

const PhotoOrnaments = ({ state, isPointing, pointPos, lockedPhotoIndex, handlePhotoLock }: { state: 'CHAOS' | 'FORMED', isPointing: boolean, pointPos: { x: number, y: number }, lockedPhotoIndex: number, handlePhotoLock: (index: number) => void }) => {
  const textures = useTexture(CONFIG.photos.body);
  const count = CONFIG.counts.ornaments;
  const groupRef = useRef<THREE.Group>(null);

  // 基础几何体：1x1 的平面，方便后续拉伸
  const baseGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const tempV = useMemo(() => new THREE.Vector3(), []);
  const cameraDir = useMemo(() => new THREE.Vector3(), []);
  const heroTargetPos = useMemo(() => new THREE.Vector3(), []);
  const targetNDC = useMemo(() => new THREE.Vector2(), []);
  
  const lockedIndexRef = useRef<number>(-1);

  const data = useMemo(() => {
    return new Array(count).fill(0).map((_, i) => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*80, (Math.random()-0.5)*60, (Math.random()-0.5)*80);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const isBig = Math.random() < 0.2;
      const baseScale = isBig ? 2.5 : 1.0 + Math.random() * 0.6;
      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];
      const rotationSpeed = { x: (Math.random()-0.5), y: (Math.random()-0.5), z: (Math.random()-0.5) };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      return {
        chaosPos, targetPos, scale: baseScale, weight,
        textureIndex: i % textures.length, borderColor,
        currentPos: chaosPos.clone(), chaosRotation, rotationSpeed,
        wobbleOffset: Math.random() * 10, wobbleSpeed: 0.5 + Math.random() * 0.5,
        // 注意：这里不再计算 aspect，因为 textures 加载可能滞后
      };
    });
  }, [textures, count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const { camera } = stateObj;
    const isFormed = state === 'FORMED';
    
    targetNDC.x = 1 - (pointPos.x * 2);
    targetNDC.y = 1 - (pointPos.y * 2);

    // --- 1. 寻找或维持锁定 ---
    let bestIdx = -1;
    let minDistSq = 0.5 * 0.5; 

    if (!isFormed) {
        if (isPointing) {
            // 手势优先：只检查手势锁定
            if (lockedIndexRef.current !== -1) {
                bestIdx = lockedIndexRef.current;
            } else {
                data.forEach((obj, i) => {
                    tempV.copy(obj.currentPos);
                    tempV.project(camera); 
                    
                    const dx = tempV.x - targetNDC.x;
                    const dy = tempV.y - targetNDC.y;
                    const distSq = dx * dx + dy * dy; 
                    
                    if (distSq < minDistSq && tempV.z < 1 && tempV.z > 0) {
                        minDistSq = distSq;
                        bestIdx = i;
                    }
                });
                if (bestIdx !== -1) {
                    lockedIndexRef.current = bestIdx;
                }
            }
        } else {
            // 手势未激活：使用鼠标锁定
            bestIdx = lockedPhotoIndex;
        }
    }

    if (!isPointing) {
        lockedIndexRef.current = -1;
    }

    // --- 2. 动画更新 ---
    groupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      // 只有当 (是最佳目标) 且 (正在指 OR 有鼠标锁) 时才选中
      const isSelected = (i === bestIdx && (isPointing || lockedPhotoIndex !== -1)); 

      let target;
      let moveSpeed = delta * (isFormed ? 1.0 * objData.weight : 1.5);

      if (isFormed) {
        target = objData.targetPos;
      } else if (isSelected) {
        camera.getWorldDirection(cameraDir);
        heroTargetPos.copy(camera.position).add(cameraDir.multiplyScalar(12));
        tempV.copy(heroTargetPos).sub(SCENE_GROUP_OFFSET);
        target = tempV; 
        moveSpeed = delta * 8.0; 
      } else {
        target = objData.chaosPos;
      }

      objData.currentPos.lerp(target, moveSpeed);
      group.position.copy(objData.currentPos);

      const targetScale = isSelected ? objData.scale * 2.0 : objData.scale;
      const currentScale = group.scale.x;
      const nextScale = THREE.MathUtils.lerp(currentScale, targetScale, delta * 5);
      // 应用整体缩放
      group.scale.set(nextScale, nextScale, nextScale);

      if (isFormed) {
         group.lookAt(new THREE.Vector3(group.position.x * 2, group.position.y, group.position.z * 2));
      } else if (isSelected) {
         const qStart = group.quaternion.clone();
         group.lookAt(camera.position);
         const qEnd = group.quaternion.clone();
         group.quaternion.copy(qStart).slerp(qEnd, delta * 10);
      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        // 【核心修复】：在渲染时实时获取纹理并计算比例
        const tex = textures[obj.textureIndex];
        
        // 如果图片加载完成（有宽度），计算比例；否则默认为 1（正方形）
        // 这样即使第一帧没加载好，下一帧更新时比例会自动修正，而不会卡在 NaN 或 0
        const rawAspect = (tex.image && tex.image.width && tex.image.height) 
                          ? tex.image.width / tex.image.height 
                          : 1;
        
        // 限制极端比例
        const aspect = Math.max(0.5, Math.min(2.0, rawAspect));

        const photoWidth = aspect;
        const photoHeight = 1;
        const borderWidth = photoWidth + 0.2;
        const borderHeight = photoHeight + 0.4;
        const borderYOffset = -0.1; 

        return (
          <group 
             key={i}
             onClick={(e) => {
                 e.stopPropagation(); 
                 handlePhotoLock(i); 
             }}
          >
             {/* 正面 */}
             <group position={[0, 0, 0.015]}>
              <mesh geometry={baseGeometry} scale={[photoWidth, photoHeight, 1]}>
                <meshStandardMaterial map={tex} roughness={0.5} emissive={CONFIG.colors.white} emissiveMap={tex} emissiveIntensity={1.0} side={THREE.FrontSide} />
              </mesh>
              <mesh geometry={baseGeometry} scale={[borderWidth, borderHeight, 1]} position={[0, borderYOffset, -0.01]}>
                <meshStandardMaterial color={obj.borderColor} roughness={0.9} side={THREE.FrontSide} />
              </mesh>
            </group>

            {/* 背面 */}
            <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
              <mesh geometry={baseGeometry} scale={[photoWidth, photoHeight, 1]}>
                <meshStandardMaterial map={tex} roughness={0.5} emissive={CONFIG.colors.white} emissiveMap={tex} emissiveIntensity={1.0} side={THREE.FrontSide} />
              </mesh>
              <mesh geometry={baseGeometry} scale={[borderWidth, borderHeight, 1]} position={[0, borderYOffset, -0.01]}>
                <meshStandardMaterial color={obj.borderColor} roughness={0.9} side={THREE.FrontSide} />
              </mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.elements;
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.5, 16, 16), []);
  const caneGeometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const type = Math.floor(Math.random() * 3);
      let color; let scale = 1;
      if (type === 0) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.8 + Math.random() * 0.4; }
      else if (type === 1) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.6 + Math.random() * 0.4; }
      else { color = Math.random() > 0.5 ? CONFIG.colors.red : CONFIG.colors.white; scale = 0.7 + Math.random() * 0.3; }

      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { type, chaosPos, targetPos, color, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry, sphereGeometry, caneGeometry]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        let geometry; if (obj.type === 0) geometry = boxGeometry; else if (obj.type === 1) geometry = sphereGeometry; else geometry = caneGeometry;
        return ( <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={geometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={obj.color} roughness={0.3} metalness={0.4} emissive={obj.color} emissiveIntensity={0.2} />
        </mesh> )})}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: CONFIG.colors.gold,
    emissive: CONFIG.colors.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};

// --- Component: Falling Snow ---
// const Snow = () => {
//   const count = 1500; // 雪花数量
//   const geomRef = useRef<THREE.BufferGeometry>(null);
  
//   // 初始化雪花位置和速度
//   const { positions, velocities } = useMemo(() => {
//     const pos = new Float32Array(count * 3);
//     const vels = new Float32Array(count); // 下落速度
    
//     for (let i = 0; i < count; i++) {
//       // 随机分布在场景中 (范围 X:-50~50, Y:-40~60, Z:-50~50)
//       pos[i * 3] = (Math.random() - 0.5) * 100;     // x
//       pos[i * 3 + 1] = (Math.random() - 0.5) * 100; // y
//       pos[i * 3 + 2] = (Math.random() - 0.5) * 100; // z
      
//       // 随机速度 2.0 到 5.0 之间
//       vels[i] = 2.0 + Math.random() * 3.0; 
//     }
//     return { positions: pos, velocities: vels };
//   }, []);

//   useFrame((_, delta) => {
//     if (!geomRef.current) return;
    
//     const posAttr = geomRef.current.attributes.position;
//     // 直接操作 buffer array 性能最好
//     const arr = posAttr.array as Float32Array; 

//     for (let i = 0; i < count; i++) {
//       // 更新 Y 轴 (下落)
//       arr[i * 3 + 1] -= velocities[i] * delta;

//       // 简单的横向飘动 (基于时间和自身索引，产生伪随机摆动)
//       arr[i * 3] += Math.sin(_.clock.elapsedTime * 0.5 + i) * 0.02;

//       // 如果落到底部 (比如 y < -40)，重置到顶部 (y = 50)
//       if (arr[i * 3 + 1] < -40) {
//         arr[i * 3 + 1] = 50;
//         // 重新随机一下 X 和 Z，避免雪花成排出现
//         arr[i * 3] = (Math.random() - 0.5) * 100;
//         arr[i * 3 + 2] = (Math.random() - 0.5) * 100;
//       }
//     }
//     posAttr.needsUpdate = true;
//   });

//   return (
//     <points>
//       <bufferGeometry ref={geomRef}>
//         <bufferAttribute 
//           attach="attributes-position" 
//           count={count} 
//           array={positions} 
//           itemSize={3} 
//         />
//       </bufferGeometry>
//       <pointsMaterial 
//         size={0.4} 
//         color="#FFFFFF" 
//         transparent 
//         opacity={0.8} 
//         depthWrite={false} 
//       />
//     </points>
//   );
// };

// --- Component: Falling Snow (Canvas Texture Version) ---
const Snow = () => {
  const count = 1500;
  const geomRef = useRef<THREE.BufferGeometry>(null);

  // 1. 使用 useMemo 动态创建一个包含 "❄️" 图案的纹理
  // 这样完全避免了 Base64 图片加载错误的问题
  const snowTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = 'transparent';
      context.fillRect(0, 0, 32, 32);
      
      // 在 Canvas 中心画一个白色的雪花文字
      context.font = '24px Arial'; // 字体大小
      context.fillStyle = 'white'; // 颜色
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('❄️', 16, 16); 
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, []);

  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const vels = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 100;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 100;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 100;
      vels[i] = 2.0 + Math.random() * 3.0;
    }
    return { positions: pos, velocities: vels };
  }, []);

  useFrame((_, delta) => {
    if (!geomRef.current) return;
    const posAttr = geomRef.current.attributes.position;
    const arr = posAttr.array as Float32Array; 
    for (let i = 0; i < count; i++) {
      // 下落逻辑
      arr[i * 3 + 1] -= velocities[i] * delta;
      // 飘动逻辑
      arr[i * 3] += Math.sin(_.clock.elapsedTime * 0.5 + i) * 0.02;

      // 触底重置
      if (arr[i * 3 + 1] < -40) {
        arr[i * 3 + 1] = 50;
        arr[i * 3] = (Math.random() - 0.5) * 100;
        arr[i * 3 + 2] = (Math.random() - 0.5) * 100;
      }
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial 
        size={0.8}            // 雪花大小
        map={snowTexture}     // 使用上面生成的 Canvas 纹理
        color="#FFFFFF"
        transparent
        opacity={0.9}
        depthWrite={false}
        alphaTest={0.01}      // 过滤掉 Canvas 的透明背景
        toneMapped={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
};

// --- Main Scene Experience ---
const Experience = ({ 
  sceneState, 
  rotationSpeed, 
  isPointing, 
  pointPos, 
  // 1. 在这里接收新的 Props
  lockedPhotoIndex, 
  handlePhotoLock 
}: { 
  sceneState: 'CHAOS' | 'FORMED', 
  rotationSpeed: number, 
  isPointing: boolean, 
  pointPos: { x: number, y: number },
  // 2. 定义类型
  lockedPhotoIndex: number,
  handlePhotoLock: (index: number) => void
}) => {
  const controlsRef = useRef<any>(null);
  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + rotationSpeed);
      controlsRef.current.update();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 8, 60]} fov={45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={rotationSpeed === 0 && sceneState === 'FORMED'} autoRotateSpeed={0.3} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
      <Environment preset="night" background={false} />

      <ambientLight intensity={0.4} color="#003311" />
      <pointLight position={[30, 30, 30]} intensity={100} color={CONFIG.colors.warmLight} />
      <pointLight position={[-30, 10, -30]} intensity={50} color={CONFIG.colors.gold} />
      <pointLight position={[0, -20, 10]} intensity={30} color="#ffffff" />

      <group position={[0, -6, 0]}>
        <Snow />  {/* <--- New! 添加这一行 */}
        <Foliage state={sceneState} />
        <Suspense fallback={null}>
            {/* 3. 在这里将 Props 传递给 PhotoOrnaments */}
            <PhotoOrnaments 
                state={sceneState} 
                isPointing={isPointing} 
                pointPos={pointPos} 
                lockedPhotoIndex={lockedPhotoIndex} // <--- 修复点：传递 lockedPhotoIndex
                handlePhotoLock={handlePhotoLock}   // <--- 修复点：传递 handlePhotoLock
            />
            <ChristmasElements state={sceneState} />
            <FairyLights state={sceneState} />
            <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={600} scale={50} size={8} speed={0.4} opacity={0.4} color={CONFIG.colors.silver} />
      </group>

      <EffectComposer>
        <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={1.5} radius={0.5} mipmapBlur />
        <Vignette eskil={false} offset={0.1} darkness={1.2} />
      </EffectComposer>
    </>
  );
};

// 更新 GestureController 的 props 定义，增加 onPointing
const GestureController = ({ onGesture, onMove, onPointing, onStatus, onPointPosition, debugMode }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let gestureRecognizer: GestureRecognizer;
    let requestRef: number;

    const setup = async () => {
      onStatus("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
        gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });
        onStatus("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
           const stream = await navigator.mediaDevices.getUserMedia({ video: true });
           if (videoRef.current) {
             videoRef.current.srcObject = stream;
             videoRef.current.play();
             onStatus("AI READY: SHOW HAND");
             predictWebcam();
           }
        } else {
            onStatus("ERROR: CAMERA PERMISSION DENIED");
        }
      } catch (err: any) { onStatus(`ERROR: ${err.message || 'MODEL FAILED'}`); }
    };

    const predictWebcam = () => {
      if (gestureRecognizer && videoRef.current && canvasRef.current) {
        if (videoRef.current.videoWidth > 0) {
            const results = gestureRecognizer.recognizeForVideo(videoRef.current, Date.now());
            const ctx = canvasRef.current.getContext("2d");
            if (ctx && debugMode) {
                ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                canvasRef.current.width = videoRef.current.videoWidth; canvasRef.current.height = videoRef.current.videoHeight;
                if (results.landmarks) for (const landmarks of results.landmarks) {
                        const drawingUtils = new DrawingUtils(ctx);
                        drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 });
                        drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 });
                }
            } else if (ctx && !debugMode) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

            if (results.gestures.length > 0) {
              const indexTip = results.landmarks[0][8];
              const pointPos = { x: indexTip.x, y: indexTip.y }; // X: 0=Left, 1=Right; Y: 0=Top, 1=Bottom
              onPointPosition(pointPos); // 传递手指位置

              // --- 手势识别逻辑 ---
              const name = results.gestures[0][0].categoryName;
              const score = results.gestures[0][0].score;

              if (score > 0.4) {
                 if (name === "Open_Palm") onGesture("CHAOS");
                 if (name === "Closed_Fist") onGesture("FORMED");
                 
                 const isPointing = name === "Pointing_Up";
                 onPointing(isPointing);

                 if (debugMode) onStatus(`DETECTED: ${name}`);
              }
              
              // 移动控制逻辑保持不变
              //const speed = (0.5 - results.landmarks[0][0].x) * 0.15;
              const speed = (0.5 - results.landmarks[0][0].x) * 0.45;
              onMove(Math.abs(speed) > 0.01 ? speed : 0);
              
            } else {
              // 没有手时，取消所有状态，并默认为屏幕中心
              onMove(0);
              onPointing(false); 
              onPointPosition({x: 0.5, y: 0.5}); 
            }
        }
        requestRef = requestAnimationFrame(predictWebcam);
      }
    };
    setup();
    return () => cancelAnimationFrame(requestRef);
  }, [onGesture, onMove, onPointing, onStatus, onPointPosition, debugMode]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>('CHAOS');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [isPointing, setIsPointing] = useState(false);
  const [pointPos, setPointPos] = useState({ x: 0.5, y: 0.5 });
  const [lockedPhotoIndex, setLockedPhotoIndex] = useState<number>(-1);
  const handlePhotoLock = (index: number) => {
        if (lockedPhotoIndex === index) {
            setLockedPhotoIndex(-1); // 解锁
            // setSceneState('FORMED'); // 假设解锁后回到树形
        } else {
            setLockedPhotoIndex(index); // 锁定
            setSceneState('CHAOS'); // 锁定后进入混沌/放大模式
        }
    };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      
      {/* 3D 场景层 */}
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas dpr={[1, 2]} gl={{ toneMapping: THREE.ReinhardToneMapping }} shadows>
           {/* <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} isPointing={isPointing} pointPos={pointPos} /> */}
           <Experience 
            sceneState={sceneState} 
            rotationSpeed={rotationSpeed} 
            isPointing={isPointing} 
            pointPos={pointPos}
            //核心修复：添加这两个缺失的属性
            lockedPhotoIndex={lockedPhotoIndex} 
            handlePhotoLock={handlePhotoLock} 
        />
        </Canvas>
      </div>

      {/* AI 控制器 */}
      <GestureController 
          onGesture={setSceneState} 
          onMove={setRotationSpeed} 
          onPointing={setIsPointing} 
          onPointPosition={setPointPos} 
          onStatus={setAiStatus} 
          debugMode={debugMode} 
      />
      
      {/* ================================================================================== */}
      {/* 【核心优化 1：全屏隐形遮挡层】 */}
      {/* 1. 不显示光标 (无 background/border) */}
      {/* 2. 禁止穿透 (pointerEvents: auto 阻挡鼠标) */}
      {/* ================================================================================== */}
      {sceneState === 'CHAOS' && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 1000, // 确保在 Canvas 之上
            
            // 【关键逻辑】：
            // 当正在指 (isPointing) 时，开启事件捕获 (auto)，鼠标无法操作背后的 Canvas。
            // 当没在指时，穿透 (none)，鼠标可以旋转地球/树。
            pointerEvents: isPointing ? 'auto' : 'none', 
            
            // 完全透明，无视觉元素
            backgroundColor: 'transparent', 
          }}
        />
      )}

      {/* UI - Stats (保持不变) */}
      <div style={{ position: 'absolute', bottom: '30px', left: '40px', color: '#888', zIndex: 10, fontFamily: 'sans-serif', userSelect: 'none', pointerEvents: 'none' }}>
        <div style={{ marginBottom: '15px' }}>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Memories</p>
          <p style={{ fontSize: '24px', color: '#FFD700', fontWeight: 'bold', margin: 0 }}>
            {CONFIG.counts.ornaments.toLocaleString()} <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>POLAROIDS</span>
          </p>
        </div>
        <div>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Foliage</p>
          <p style={{ fontSize: '24px', color: '#004225', fontWeight: 'bold', margin: 0 }}>
            {(CONFIG.counts.foliage / 1000).toFixed(0)}K <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>EMERALD NEEDLES</span>
          </p>
        </div>
      </div>

      {/* UI - Buttons (保持不变) */}
      <div style={{ position: 'absolute', bottom: '30px', right: '40px', zIndex: 10, display: 'flex', gap: '10px' }}>
        <button onClick={() => setDebugMode(!debugMode)} style={{ padding: '12px 15px', backgroundColor: debugMode ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: debugMode ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {debugMode ? 'HIDE DEBUG' : '🛠 DEBUG'}
        </button>
        <button onClick={() => setSceneState(s => s === 'CHAOS' ? 'FORMED' : 'CHAOS')} style={{ padding: '12px 30px', backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255, 215, 0, 0.5)', color: '#FFD700', fontFamily: 'serif', fontSize: '14px', fontWeight: 'bold', letterSpacing: '3px', textTransform: 'uppercase', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {sceneState === 'CHAOS' ? 'Assemble Tree' : 'Disperse'}
        </button>
      </div>

      {/* UI - AI Status (保持不变) */}
      <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', color: aiStatus.includes('ERROR') ? '#FF0000' : 'rgba(255, 215, 0, 0.4)', fontSize: '10px', letterSpacing: '2px', zIndex: 10, background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none' }}>
        {aiStatus}
      </div>
    </div>
  );
}