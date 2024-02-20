import * as THREE from 'three';
import { SplatScene } from './SplatScene.js';
import { SplatTree } from './splattree/SplatTree.js';
import { WebGLExtensions } from './three-shim/WebGLExtensions.js';
import { WebGLCapabilities } from './three-shim/WebGLCapabilities.js';
import { uintEncodedFloat, rgbaArrayToInteger } from './Util.js';
import { Constants } from './Constants.js';

const dummyGeometry = new THREE.BufferGeometry();
const dummyMaterial = new THREE.MeshBasicMaterial();

const COVARIANCES_ELEMENTS_PER_SPLAT = 6;
const CENTER_COLORS_ELEMENTS_PER_SPLAT = 4;

/**
 * SplatMesh: Container for one or more splat scenes, abstracting them into a single unified container for
 * splat data. Additionally contains data structures and code to make the splat data renderable as a Three.js mesh.
 */
export class SplatMesh extends THREE.Mesh {

    constructor(dynamicMode = true, halfPrecisionCovariancesOnGPU = false, devicePixelRatio = 1,
                enableDistancesComputationOnGPU = true, integerBasedDistancesComputation = false) {
        super(dummyGeometry, dummyMaterial);
        // Reference to a Three.js renderer
        this.renderer = undefined;
        // Use 16-bit floating point values when storing splat covariance data in textures, instead of 32-bit
        this.halfPrecisionCovariancesOnGPU = halfPrecisionCovariancesOnGPU;
        // When 'dynamicMode' is true, scenes are assumed to be non-static. Dynamic scenes are handled differently
        // and certain optimizations cannot be made for them. Additionally, by default, all splat data retrieved from
        // this splat mesh will not have their scene transform applied to them if the splat mesh is dynamic. That
        // can be overriden via parameters to the individual functions that are used to retrieve splat data.
        this.dynamicMode = dynamicMode;
        // Ratio of the resolution in physical pixels to the resolution in CSS pixels for the current display device
        this.devicePixelRatio = devicePixelRatio;
        // Use a transform feedback to calculate splat distances from the camera
        this.enableDistancesComputationOnGPU = enableDistancesComputationOnGPU;
        // Use a faster integer-based approach for calculating splat distances from the camera
        this.integerBasedDistancesComputation = integerBasedDistancesComputation;
        // The individual splat scenes stored in this splat mesh, each containing their own transform
        this.scenes = [];
        // Special octree tailored to SplatMesh instances
        this.splatTree = null;
        // Textures in which splat data will be stored for rendering
        this.splatDataTextures = {};
        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'transformIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'transformIndexesLoc': -1,
            'transformsLocs': []
        };
        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];

        this.lastBuildSplatCount = [];
        this.lastBuildScenes = [];
        this.lastBuildMaxSplatCount = 0;
        this.lastBuildSceneCount = 0;

        this.webGLUtils = null;
    }

    /**
     * Build the Three.js material that is used to render the splats.
     * @param {number} dynamicMode If true, it means the scene geometry represented by this splat mesh is not stationary or
     *                             that the splat count might change
     * @return {THREE.ShaderMaterial}
     */
    static buildMaterial(dynamicMode = false) {

        // Contains the code to project 3D covariance to 2D and from there calculate the quad (using the eigen vectors of the
        // 2D covariance) that is ultimately rasterized
        let vertexShaderSource = `
            precision highp float;
            #include <common>

            attribute uint splatIndex;

            uniform highp sampler2D covariancesTexture;
            uniform highp usampler2D centersColorsTexture;`;

        if (dynamicMode) {
            vertexShaderSource += `
                uniform highp usampler2D transformIndexesTexture;
                uniform highp mat4 transforms[${Constants.MaxScenes}];
                uniform vec2 transformIndexesTextureSize;
            `;
        }

        vertexShaderSource += `
            uniform vec2 focal;
            uniform vec2 viewport;
            uniform vec2 basisViewport;
            uniform vec2 covariancesTextureSize;
            uniform vec2 centersColorsTextureSize;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            const float sqrt8 = sqrt(8.0);

            const vec4 encodeNorm4 = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0);
            const uvec4 mask4 = uvec4(uint(0x000000FF), uint(0x0000FF00), uint(0x00FF0000), uint(0xFF000000));
            const uvec4 shift4 = uvec4(0, 8, 16, 24);
            vec4 uintToRGBAVec (uint u) {
               uvec4 urgba = mask4 & u;
               urgba = urgba >> shift4;
               vec4 rgba = vec4(urgba) * encodeNorm4;
               return rgba;
            }

            vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
                vec2 samplerUV = vec2(0.0, 0.0);
                float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
                samplerUV.y = float(floor(d)) / dimensions.y;
                samplerUV.x = fract(d);
                return samplerUV;
            }

            void main () {

                uvec4 sampledCenterColor = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize));
                vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));`;

            if (dynamicMode) {
                vertexShaderSource += `
                    uint transformIndex = texture(transformIndexesTexture, getDataUV(1, 0, transformIndexesTextureSize)).r;
                    mat4 transform = transforms[transformIndex];
                    mat4 transformModelViewMatrix = modelViewMatrix * transform;
                `;
            } else {
                vertexShaderSource += `mat4 transformModelViewMatrix = modelViewMatrix;`;
            }

            vertexShaderSource += `
                vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);

                vec4 clipCenter = projectionMatrix * viewCenter;

                float clip = 1.2 * clipCenter.w;
                if (clipCenter.z < -clip || clipCenter.x < -clip || clipCenter.x > clip || clipCenter.y < -clip || clipCenter.y > clip) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }

                vPosition = position.xy;
                vColor = uintToRGBAVec(sampledCenterColor.r);

                vec2 sampledCovarianceA = texture(covariancesTexture, getDataUV(3, 0, covariancesTextureSize)).rg;
                vec2 sampledCovarianceB = texture(covariancesTexture, getDataUV(3, 1, covariancesTextureSize)).rg;
                vec2 sampledCovarianceC = texture(covariancesTexture, getDataUV(3, 2, covariancesTextureSize)).rg;

                vec3 cov3D_M11_M12_M13 = vec3(sampledCovarianceA.rg, sampledCovarianceB.r);
                vec3 cov3D_M22_M23_M33 = vec3(sampledCovarianceB.g, sampledCovarianceC.rg);

                // Construct the 3D covariance matrix
                mat3 Vrk = mat3(
                    cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                    cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                    cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
                );

                // Construct the Jacobian of the affine approximation of the projection matrix. It will be used to transform the
                // 3D covariance matrix instead of using the actual projection matrix because that transformation would
                // require a non-linear component (perspective division) which would yield a non-gaussian result. (This assumes
                // the current projection is a perspective projection).
                float s = 1.0 / (viewCenter.z * viewCenter.z);
                mat3 J = mat3(
                    focal.x / viewCenter.z, 0., -(focal.x * viewCenter.x) * s,
                    0., focal.y / viewCenter.z, -(focal.y * viewCenter.y) * s,
                    0., 0., 0.
                );

                // Concatenate the projection approximation with the model-view transformation
                mat3 W = transpose(mat3(transformModelViewMatrix));
                mat3 T = W * J;

                // Transform the 3D covariance matrix (Vrk) to compute the 2D covariance matrix
                mat3 cov2Dm = transpose(T) * Vrk * T;

                cov2Dm[0][0] += 0.3;
                cov2Dm[1][1] += 0.3;

                // We are interested in the upper-left 2x2 portion of the projected 3D covariance matrix because
                // we only care about the X and Y values. We want the X-diagonal, cov2Dm[0][0],
                // the Y-diagonal, cov2Dm[1][1], and the correlation between the two cov2Dm[0][1]. We don't
                // need cov2Dm[1][0] because it is a symetric matrix.
                vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

                vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

                // We now need to solve for the eigen-values and eigen vectors of the 2D covariance matrix
                // so that we can determine the 2D basis for the splat. This is done using the method described
                // here: https://people.math.harvard.edu/~knill/teaching/math21b2004/exhibits/2dmatrices/index.html
                // After calculating the eigen-values and eigen-vectors, we calculate the basis for rendering the splat
                // by normalizing the eigen-vectors and then multiplying them by (sqrt(8) * eigen-value), which is
                // equal to scaling them by sqrt(8) standard deviations.
                //
                // This is a different approach than in the original work at INRIA. In that work they compute the
                // max extents of the projected splat in screen space to form a screen-space aligned bounding rectangle
                // which forms the geometry that is actually rasterized. The dimensions of that bounding box are 3.0
                // times the maximum eigen-value, or 3 standard deviations. They then use the inverse 2D covariance
                // matrix (called 'conic') in the CUDA rendering thread to determine fragment opacity by calculating the
                // full gaussian: exp(-0.5 * (X - mean) * conic * (X - mean)) * splat opacity
                float a = cov2Dv.x;
                float d = cov2Dv.z;
                float b = cov2Dv.y;
                float D = a * d - b * b;
                float trace = a + d;
                float traceOver2 = 0.5 * trace;
                float term2 = sqrt(max(0.1f, traceOver2 * traceOver2 - D));
                float eigenValue1 = traceOver2 + term2;
                float eigenValue2 = traceOver2 - term2;

                float transparentAdjust = step(1.0 / 255.0, vColor.a);
                eigenValue2 = eigenValue2 * transparentAdjust; // hide splat if alpha is zero

                vec2 eigenVector1 = normalize(vec2(b, eigenValue1 - a));
                // since the eigen vectors are orthogonal, we derive the second one from the first
                vec2 eigenVector2 = vec2(eigenVector1.y, -eigenVector1.x);

                // We use sqrt(8) standard deviations instead of 3 to eliminate more of the splat with a very low opacity.
                vec2 basisVector1 = eigenVector1 * sqrt8 * sqrt(eigenValue1);
                vec2 basisVector2 = eigenVector2 * sqrt8 * sqrt(eigenValue2);

                vec2 ndcOffset = vec2(vPosition.x * basisVector1 + vPosition.y * basisVector2) * basisViewport * 2.0;

                // Similarly scale the position data we send to the fragment shader
                vPosition *= sqrt8;

                gl_Position = vec4(ndcCenter.xy  + ndcOffset, ndcCenter.z, 1.0);

            }`;

        const fragmentShaderSource = `
            precision highp float;
            #include <common>
 
            uniform vec3 debugColor;

            varying vec4 vColor;
            varying vec2 vUv;

            varying vec2 vPosition;

            void main () {
                // Compute the positional squared distance from the center of the splat to the current fragment.
                float A = dot(vPosition, vPosition);
                // Since the positional data in vPosition has been scaled by sqrt(8), the squared result will be
                // scaled by a factor of 8. If the squared result is larger than 8, it means it is outside the ellipse
                // defined by the rectangle formed by vPosition. It also means it's farther
                // away than sqrt(8) standard deviations from the mean.
                if (A > 8.0) discard;
                vec3 color = vColor.rgb;

                // Since the rendered splat is scaled by sqrt(8), the inverse covariance matrix that is part of
                // the gaussian formula becomes the identity matrix. We're then left with (X - mean) * (X - mean),
                // and since 'mean' is zero, we have X * X, which is the same as A:
                float opacity = exp(-0.5 * A) * vColor.a;

                gl_FragColor = vec4(color.rgb, opacity);
            }`;

        const uniforms = {
            'covariancesTexture': {
                'type': 't',
                'value': null
            },
            'centersColorsTexture': {
                'type': 't',
                'value': null
            },
            'focal': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'basisViewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'debugColor': {
                'type': 'v3',
                'value': new THREE.Color()
            },
            'covariancesTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'centersColorsTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            }
        };

        if (dynamicMode) {
            uniforms['transformIndexesTexture'] = {
                'type': 't',
                'value': null
            };
            const transformMatrices = [];
            for (let i = 0; i < Constants.MaxScenes; i++) {
                transformMatrices.push(new THREE.Matrix4());
            }
            uniforms['transforms'] = {
                'type': 'mat4',
                'value': transformMatrices
            };
            uniforms['transformIndexesTextureSize'] = {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            };
        }

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            alphaTest: 1.0,
            blending: THREE.NormalBlending,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        return material;
    }

    /**
     * Build the Three.js geometry that will be used to render the splats. The geometry is instanced and is made up of
     * vertices for a single quad as well as an attribute buffer for the splat indexes.
     * @param {number} maxSplatCount The maximum number of splats that the geometry will need to accomodate
     * @return {THREE.InstancedBufferGeometry}
     */
    static buildGeomtery(maxSplatCount) {

        const baseGeometry = new THREE.BufferGeometry();
        baseGeometry.setIndex([0, 1, 2, 0, 2, 3]);

        // Vertices for the instanced quad
        const positionsArray = new Float32Array(4 * 3);
        const positions = new THREE.BufferAttribute(positionsArray, 3);
        baseGeometry.setAttribute('position', positions);
        positions.setXYZ(0, -1.0, -1.0, 0.0);
        positions.setXYZ(1, -1.0, 1.0, 0.0);
        positions.setXYZ(2, 1.0, 1.0, 0.0);
        positions.setXYZ(3, 1.0, -1.0, 0.0);
        positions.needsUpdate = true;

        const geometry = new THREE.InstancedBufferGeometry().copy(baseGeometry);

        // Splat index buffer
        const splatIndexArray = new Uint32Array(maxSplatCount);
        const splatIndexes = new THREE.InstancedBufferAttribute(splatIndexArray, 1, false);
        splatIndexes.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('splatIndex', splatIndexes);

        geometry.instanceCount = 0;

        return geometry;
    }

    /**
     * Build a container for each scene managed by this splat mesh based on an instance of SplatBuffer, along with optional
     * transform data (position, scale, rotation) passed to the splat mesh during the build process.
     * @param {Array<THREE.Matrix4>} splatBuffers SplatBuffer instances containing splats for each scene
     * @param {Array<object>} sceneOptions Array of options objects: {
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @return {Array<THREE.Matrix4>}
     */
    static buildScenes(splatBuffers, sceneOptions) {
        const scenes = [];
        scenes.length = splatBuffers.length;
        for (let i = 0; i < splatBuffers.length; i++) {
            const splatBuffer = splatBuffers[i];
            const options = sceneOptions[i] || {};
            let positionArray = options['position'] || [0, 0, 0];
            let rotationArray = options['rotation'] || [0, 0, 0, 1];
            let scaleArray = options['scale'] || [1, 1, 1];
            const position = new THREE.Vector3().fromArray(positionArray);
            const rotation = new THREE.Quaternion().fromArray(rotationArray);
            const scale = new THREE.Vector3().fromArray(scaleArray);
            scenes[i] = SplatMesh.createScene(splatBuffer, position, rotation, scale);
        }
        return scenes;
    }

    static createScene(splatBuffer, position, rotation, scale) {
        return new SplatScene(splatBuffer, position, rotation, scale);
    }

    /**
     * Build data structures that map global splat indexes (based on a unified index across all splat buffers) to
     * local data within a single scene.
     * @param {Array<SplatBuffer>} splatBuffers Instances of SplatBuffer off which to build the maps
     * @return {object}
     */
    static buildSplatIndexMaps(splatBuffers) {
        const localSplatIndexMap = [];
        const sceneIndexMap = [];
        let totalSplatCount = 0;
        for (let s = 0; s < splatBuffers.length; s++) {
            const splatBuffer = splatBuffers[s];
            const maxSplatCount = splatBuffer.getMaxSplatCount();
            for (let i = 0; i < maxSplatCount; i++) {
                localSplatIndexMap[totalSplatCount] = i;
                sceneIndexMap[totalSplatCount] = s;
                totalSplatCount++;
            }
        }
        return {
            localSplatIndexMap,
            sceneIndexMap
        };
    }

    /**
     * Build an instance of SplatTree (a specialized octree) for the given splat mesh.
     * @param {SplatMesh} splatMesh SplatMesh instance for which the splat tree will be built
     * @param {Array<number>} minAlphas Array of minimum splat slphas for each scene
     * @return {SplatTree}
     */
    static buildSplatTree = function(splatMesh, minAlphas = []) {
        return new Promise((resolve) => {
            // TODO: expose SplatTree constructor parameters (maximumDepth and maxCentersPerNode) so that they can
            // be configured on a per-scene basis
            const splatTree = new SplatTree(8, 1000);
            console.time('SplatTree build');
            const splatColor = new THREE.Vector4();
            splatTree.processSplatMesh(splatMesh, (splatIndex) => {
                splatMesh.getSplatColor(splatIndex, splatColor);
                const sceneIndex = splatMesh.getSceneIndexForSplat(splatIndex);
                const minAlpha = minAlphas[sceneIndex] || 1;
                return splatColor.w >= minAlpha;
            })
            .then(() => {
                console.timeEnd('SplatTree build');

                let leavesWithVertices = 0;
                let avgSplatCount = 0;
                let maxSplatCount = 0;
                let nodeCount = 0;

                splatTree.visitLeaves((node) => {
                    const nodeSplatCount = node.data.indexes.length;
                    if (nodeSplatCount > 0) {
                        avgSplatCount += nodeSplatCount;
                        maxSplatCount = Math.max(maxSplatCount, nodeSplatCount);
                        nodeCount++;
                        leavesWithVertices++;
                    }
                });
                console.log(`SplatTree leaves: ${splatTree.countLeaves()}`);
                console.log(`SplatTree leaves with splats:${leavesWithVertices}`);
                avgSplatCount = avgSplatCount / nodeCount;
                console.log(`Avg splat count per node: ${avgSplatCount}`);
                console.log(`Total splat count: ${splatMesh.getSplatCount()}`);
                resolve(splatTree);
            });
        });
    };

    /**
     * Construct this instance of SplatMesh.
     * @param {Array<SplatBuffer>} splatBuffers The base splat data, instances of SplatBuffer
     * @param {Array<object>} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     * }
     * @param {Boolean} keepSceneTransforms For a scene that already exists and is being overwritten, this flag
     *                                      says to keep the transform from the existing scene.
     */
    build(splatBuffers, sceneOptions, keepSceneTransforms = true, buildSplatTrees = false) {

        const maxSplatCount = SplatMesh.getTotalMaxSplatCountForSplatBuffers(splatBuffers);

        const newScenes = SplatMesh.buildScenes(splatBuffers, sceneOptions);
        if (keepSceneTransforms) {
            for (let i = 0; i < this.scenes.length && i < newScenes.length; i++) {
                const newScene = newScenes[i];
                const existingScene = this.getScene(i);
                newScene.copyTransformData(existingScene);
            }
        }
        this.scenes = newScenes;

        let isUpdateBuild = true;
        if (this.lastBuildSceneCount !== this.scenes.length || this.lastBuildMaxSplatCount !== maxSplatCount) isUpdateBuild = false;
        if (this.scenes.length === this.lastBuildScenes.length) {
            for (let i = 0; i < this.scenes.length; i++) {
                if (this.scenes[i].splatBuffer !== this.lastBuildScenes[i].splatBuffer) {
                    isUpdateBuild = false;
                    break;
                }
            }
        } else {
            isUpdateBuild = false;
        }
        if (!isUpdateBuild) {
            this.lastBuildSplatCount = [];
            this.lastBuildScenes = [];
            for (let i = 0; i < this.scenes.length; i++) this.lastBuildSplatCount[i] = 0;
            this.lastBuildMaxSplatCount = 0;
        }

        // TODO(StreamBuild): Clean up check for streaming construction here
        if (!isUpdateBuild) {
            this.disposeMeshData();
            this.geometry = SplatMesh.buildGeomtery(maxSplatCount);
            this.material = SplatMesh.buildMaterial(this.dynamicMode);
            const indexMaps = SplatMesh.buildSplatIndexMaps(splatBuffers);
            this.globalSplatIndexToLocalSplatIndexMap = indexMaps.localSplatIndexMap;
            this.globalSplatIndexToSceneIndexMap = indexMaps.sceneIndexMap;
        }

        if (this.enableDistancesComputationOnGPU) this.setupDistancesComputationTransformFeedback();
        this.resetGPUDataFromSplatBuffers(isUpdateBuild);

        for (let i = 0; i < this.scenes.length; i++) {
            this.lastBuildSplatCount[i] = this.scenes[i].splatBuffer.getSplatCount();
            this.lastBuildScenes[i] = this.scenes[i];
        }
        this.lastBuildMaxSplatCount = this.getMaxSplatCount();
        this.lastBuildSceneCount = this.scenes.length;

        if (buildSplatTrees) {
            this.disposeSplatTree();
            SplatMesh.buildSplatTree(this, sceneOptions.map(options => options.splatAlphaRemovalThreshold || 1))
            .then((splatTree) => {
           //     this.splatTree = splatTree;
            });
        }
    }

    /**
     * Dispose all resources held by the splat mesh
     */
    dispose() {
        this.disposeMeshData();
        this.disposeTextures();
        this.disposeSplatTree();
        if (this.enableDistancesComputationOnGPU) {
            this.disposeDistancesComputationGPUResources();
        }
    }

    /**
     * Dispose of only the Three.js mesh resources (geometry, material, and texture)
     */
    disposeMeshData() {
        if (this.geometry && this.geometry !== dummyGeometry) {
            this.geometry.dispose();
            this.geometry = null;
        }
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
    }

    disposeTextures() {
        for (let textureKey in this.splatDataTextures) {
            if (this.splatDataTextures.hasOwnProperty(textureKey)) {
                const textureContainer = this.splatDataTextures[textureKey];
                if (textureContainer.texture) {
                    textureContainer.texture.dispose();
                    textureContainer.texture = null;
                }
            }
        }
        this.splatDataTextures = null;
    }

    disposeSplatTree() {
        this.splatTree = null;
    }

    getSplatTree() {
        return this.splatTree;
    }

    /**
     * Refresh data textures and GPU buffers for splat distance pre-computation with data from the splat buffers for this mesh.
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     */
    resetGPUDataFromSplatBuffers(sinceLastBuild) {
        this.uploadSplatDataToTextures(sinceLastBuild);
        if (this.enableDistancesComputationOnGPU) {
            this.updateGPUCentersBufferForDistancesComputation(sinceLastBuild);
            this.updateGPUTransformIndexesBufferForDistancesComputation();
        }
    }

    static computeTextureUpdateRegion(startSplat, endSplat, textureWidth, textureHeight, elementsPerTexel, elementsPerSplat) {
        const texelsPerSplat = elementsPerSplat / elementsPerTexel;

        const startSplatTexels = startSplat * texelsPerSplat;
        const startRow = Math.floor(startSplatTexels / textureWidth);
        const startRowElement = startRow * textureWidth * elementsPerTexel;

        const endSplatTexels = endSplat * texelsPerSplat;
        const endRow = Math.floor(endSplatTexels / textureWidth);
        const endRowEndElement = endRow * textureWidth * elementsPerTexel + (textureWidth * elementsPerTexel);

        return {
            'dataStart': startRowElement,
            'dataEnd': endRowEndElement,
            'startRow': startRow,
            'endRow': endRow
        };
    }

     updateDataTexture(paddedData, textureDesc, textureProps, elementsPerTexel, elementsPerSplat, bytesPerElement) {
        const splatCount = this.getSplatCount();
        const gl = this.renderer.getContext();
        const updateRegion = SplatMesh.computeTextureUpdateRegion(this.lastBuildSplatCount, splatCount - 1, textureDesc.size.x,
                                                                  textureDesc.size.y, elementsPerTexel, elementsPerSplat);
        const updateElementCount = updateRegion.dataEnd - updateRegion.dataStart;
        const updateDataView = new paddedData.constructor(paddedData.buffer,
                                                          updateRegion.dataStart * bytesPerElement, updateElementCount);
        const updateHeight = updateRegion.endRow - updateRegion.startRow + 1;
        const dataTexture = textureDesc.texture;
        const glType = this.webGLUtils.convert(dataTexture.type);
        const glFormat = this.webGLUtils.convert(dataTexture.format, dataTexture.colorSpace);
        const currentTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, textureProps.__webglTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, updateRegion.startRow,
                         textureDesc.size.x, updateHeight, glFormat, glType, updateDataView);
        gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    }

    /**
     * Refresh data textures with data from the splat buffers for this mesh.
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     */
    uploadSplatDataToTextures(sinceLastBuild) {

        this.checkForMultiSceneUpdateCondition(sinceLastBuild, 'uploadSplatDataToTextures', 'sinceLastBuild');

        const COVARIANCES_ELEMENTS_PER_TEXEL = 2;
        const CENTER_COLORS_ELEMENTS_PER_TEXEL = 4;
        const TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL = 1;

        const maxSplatCount = this.getMaxSplatCount();
        const splatCount = this.getSplatCount();

        const updateCenterColorsPaddedData = (to, from, centers, colors, paddedCenterColors) => {
            for (let c = to; c < from; c++) {
                const colorsBase = c * 4;
                const centersBase = c * 3;
                const centerColorsBase = c * 4;
                paddedCenterColors[centerColorsBase] = rgbaArrayToInteger(colors, colorsBase);
                paddedCenterColors[centerColorsBase + 1] = uintEncodedFloat(centers[centersBase]);
                paddedCenterColors[centerColorsBase + 2] = uintEncodedFloat(centers[centersBase + 1]);
                paddedCenterColors[centerColorsBase + 3] = uintEncodedFloat(centers[centersBase + 2]);
            }
        };

        const computeDataTextureSize = (elementsPerTexel, elementsPerSplatl) => {
            const texSize = new THREE.Vector2(4096, 1024);
            while (texSize.x * texSize.y * elementsPerTexel < maxSplatCount * elementsPerSplatl) texSize.y *= 2;
            return texSize;
        };

        if (!sinceLastBuild) {

            this.disposeTextures();

            const covariances = new Float32Array(maxSplatCount * COVARIANCES_ELEMENTS_PER_SPLAT);
            const centers = new Float32Array(maxSplatCount * 3);
            const colors = new Uint8Array(maxSplatCount * 4);
            this.fillSplatDataArrays(covariances, centers, colors);

            // set up covariances data texture
            const covTexSize = computeDataTextureSize(COVARIANCES_ELEMENTS_PER_TEXEL, 6);
            let CovariancesDataType = this.halfPrecisionCovariancesOnGPU ? Uint16Array : Float32Array;
            let covariancesTextureType = this.halfPrecisionCovariancesOnGPU ? THREE.HalfFloatType : THREE.FloatType;
            const paddedCovariances = new CovariancesDataType(covTexSize.x * covTexSize.y * COVARIANCES_ELEMENTS_PER_TEXEL);
            paddedCovariances.set(covariances);
            const covTex = new THREE.DataTexture(paddedCovariances, covTexSize.x, covTexSize.y, THREE.RGFormat, covariancesTextureType);
            covTex.needsUpdate = true;
            this.material.uniforms.covariancesTexture.value = covTex;
            this.material.uniforms.covariancesTextureSize.value.copy(covTexSize);

            // set up centers/colors data texture
            const centersColsTexSize = computeDataTextureSize(CENTER_COLORS_ELEMENTS_PER_TEXEL, 4);
            const paddedCentersCols = new Uint32Array(centersColsTexSize.x * centersColsTexSize.y * CENTER_COLORS_ELEMENTS_PER_TEXEL);
            updateCenterColorsPaddedData(0, splatCount, centers, colors, paddedCentersCols);
            const centersColsTex = new THREE.DataTexture(paddedCentersCols, centersColsTexSize.x, centersColsTexSize.y,
                                                         THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
            centersColsTex.internalFormat = 'RGBA32UI';
            centersColsTex.needsUpdate = true;
            this.material.uniforms.centersColorsTexture.value = centersColsTex;
            this.material.uniforms.centersColorsTextureSize.value.copy(centersColsTexSize);
            this.material.uniformsNeedUpdate = true;

            this.splatDataTextures = {
                'baseData': {
                    'covariances': covariances,
                    'centers': centers,
                    'colors': colors
                },
                'covariances': {
                    'data': paddedCovariances,
                    'texture': covTex,
                    'size': covTexSize
                },
                'centerColors': {
                    'data': paddedCentersCols,
                    'texture': centersColsTex,
                    'size': centersColsTexSize
                }
            };

            if (this.dynamicMode) {
                const transformIndexesTexSize = computeDataTextureSize(TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL, 4);
                const paddedTransformIndexes = new Uint32Array(transformIndexesTexSize.x *
                                                               transformIndexesTexSize.y * TRANSFORM_INDEXES_ELEMENTS_PER_TEXEL);
                for (let c = 0; c < splatCount; c++) paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
                const transformIndexesTexture = new THREE.DataTexture(paddedTransformIndexes, transformIndexesTexSize.x,
                                                                      transformIndexesTexSize.y, THREE.RedIntegerFormat,
                                                                      THREE.UnsignedIntType);
                transformIndexesTexture.internalFormat = 'R32UI';
                transformIndexesTexture.needsUpdate = true;
                this.material.uniforms.transformIndexesTexture.value = transformIndexesTexture;
                this.material.uniforms.transformIndexesTextureSize.value.copy(transformIndexesTexSize);
                this.material.uniformsNeedUpdate = true;
                this.splatDataTextures['tansformIndexes'] = {
                    'data': paddedTransformIndexes,
                    'texture': transformIndexesTexture,
                    'size': transformIndexesTexSize
                };
            }
        } else {

            this.fillSplatDataArrays(this.splatDataTextures.baseData.covariances,
                                     this.splatDataTextures.baseData.centers, this.splatDataTextures.baseData.colors, undefined, true);

            const covariancesTextureDescriptor = this.splatDataTextures['covariances'];
            const paddedCovariances = covariancesTextureDescriptor.data;
            const covariancesTexture = covariancesTextureDescriptor.texture;
            const covarancesStartSplat = this.lastBuildSplatCount * COVARIANCES_ELEMENTS_PER_SPLAT;
            const covariancesEndSplat = splatCount * COVARIANCES_ELEMENTS_PER_SPLAT;
            for (let i = covarancesStartSplat; i < covariancesEndSplat; i++) {
                const covariance = this.splatDataTextures.baseData.covariances[i];
                paddedCovariances[i] = covariance;
            }
            const covariancesTextureProps = this.renderer.properties.get(covariancesTexture);
            if (!covariancesTextureProps.__webglTexture) {
                covariancesTexture.needsUpdate = true;
            } else {
                const covaranceBytesPerElement = this.halfPrecisionCovariancesOnGPU ? 2 : 4;
                this.updateDataTexture(paddedCovariances, covariancesTextureDescriptor, covariancesTextureProps,
                                       COVARIANCES_ELEMENTS_PER_TEXEL, COVARIANCES_ELEMENTS_PER_SPLAT, covaranceBytesPerElement);
            }

            const centerColorsTextureDescriptor = this.splatDataTextures['centerColors'];
            const paddedCenterColors = centerColorsTextureDescriptor.data;
            const centerColorsTexture = centerColorsTextureDescriptor.texture;
            updateCenterColorsPaddedData(this.lastBuildSplatCount, splatCount, this.splatDataTextures.baseData.centers,
                                         this.splatDataTextures.baseData.colors, paddedCenterColors);
            const centerColorsTextureProps = this.renderer.properties.get(centerColorsTexture);
            if (!centerColorsTextureProps.__webglTexture) {
                centerColorsTexture.needsUpdate = true;
            } else {
                this.updateDataTexture(paddedCenterColors, centerColorsTextureDescriptor, centerColorsTextureProps,
                                       CENTER_COLORS_ELEMENTS_PER_TEXEL, CENTER_COLORS_ELEMENTS_PER_SPLAT, 4);
            }

            if (this.dynamicMode) {
                const transformIndexesTexDesc = this.splatDataTextures['tansformIndexes'];
                const paddedTransformIndexes = transformIndexesTexDesc.data;
                for (let c = this.lastBuildSplatCount; c < splatCount; c++) {
                    paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
                }

                const paddedTransformIndexesTexture = transformIndexesTexDesc.texture;
                const transformIndexesTextureProps = this.renderer.properties.get(paddedTransformIndexesTexture);
                if (!transformIndexesTextureProps.__webglTexture) {
                    paddedTransformIndexesTexture.needsUpdate = true;
                } else {
                    this.updateDataTexture(paddedTransformIndexes, transformIndexesTexDesc, transformIndexesTextureProps, 1, 1, 1);
                }
            }
        }
    }

    /**
     * Set the indexes of splats that should be rendered; should be sorted in desired render order.
     * @param {Uint32Array} globalIndexes Sorted index list of splats to be rendered
     * @param {number} renderSplatCount Total number of splats to be rendered. Necessary because we may not want to render
     *                                  every splat.
     */
    updateRenderIndexes(globalIndexes, renderSplatCount) {
        const geometry = this.geometry;
        geometry.attributes.splatIndex.set(globalIndexes);
        geometry.attributes.splatIndex.needsUpdate = true;
        geometry.instanceCount = renderSplatCount;
    }

    /**
     * Update the transforms for each scene in this splat mesh from their individual components (position,
     * quaternion, and scale)
     */
    updateTransforms() {
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            scene.updateTransform();
        }
    }

    updateUniforms = function() {

        const viewport = new THREE.Vector2();

        return function(renderDimensions, cameraFocalLengthX, cameraFocalLengthY) {
            const splatCount = this.getSplatCount();
            if (splatCount > 0) {
                viewport.set(renderDimensions.x * this.devicePixelRatio,
                             renderDimensions.y * this.devicePixelRatio);
                this.material.uniforms.viewport.value.copy(viewport);
                this.material.uniforms.basisViewport.value.set(1.0 / viewport.x, 1.0 / viewport.y);
                this.material.uniforms.focal.value.set(cameraFocalLengthX, cameraFocalLengthY);
                if (this.dynamicMode) {
                    for (let i = 0; i < this.scenes.length; i++) {
                        this.material.uniforms.transforms.value[i].copy(this.getScene(i).transform);
                    }
                }
                this.material.uniformsNeedUpdate = true;
            }
        };

    }();

    getSplatDataTextures() {
        return this.splatDataTextures;
    }

    getSplatCount() {
        return SplatMesh.getTotalSplatCountForScenes(this.scenes);
    }

    static getTotalSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getSplatCount();
        return totalSplatCount;
    }

    getMaxSplatCount() {
        return SplatMesh.getTotalMaxSplatCountForScenes(this.scenes);
    }

    static getTotalMaxSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getMaxSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalMaxSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getMaxSplatCount();
        return totalSplatCount;
    }

    disposeDistancesComputationGPUResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.vao) {
            gl.deleteVertexArray(this.distancesTransformFeedback.vao);
            this.distancesTransformFeedback.vao = null;
        }
        if (this.distancesTransformFeedback.program) {
            gl.deleteProgram(this.distancesTransformFeedback.program);
            gl.deleteShader(this.distancesTransformFeedback.vertexShader);
            gl.deleteShader(this.distancesTransformFeedback.fragmentShader);
            this.distancesTransformFeedback.program = null;
            this.distancesTransformFeedback.vertexShader = null;
            this.distancesTransformFeedback.fragmentShader = null;
        }
        this.disposeDistancesComputationGPUBufferResources();
        if (this.distancesTransformFeedback.id) {
            gl.deleteTransformFeedback(this.distancesTransformFeedback.id);
            this.distancesTransformFeedback.id = null;
        }
    }

    disposeDistancesComputationGPUBufferResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.centersBuffer) {
            this.distancesTransformFeedback.centersBuffer = null;
            gl.deleteBuffer(this.distancesTransformFeedback.centersBuffer);
        }
        if (this.distancesTransformFeedback.outDistancesBuffer) {
            gl.deleteBuffer(this.distancesTransformFeedback.outDistancesBuffer);
            this.distancesTransformFeedback.outDistancesBuffer = null;
        }
    }

    /**
     * Set the Three.js renderer used by this splat mesh
     * @param {THREE.WebGLRenderer} renderer Instance of THREE.WebGLRenderer
     */
    setRenderer(renderer) {
        if (renderer !== this.renderer) {
            this.renderer = renderer;
            const gl = this.renderer.getContext();
            const extensions = new WebGLExtensions(gl);
            const capabilities = new WebGLCapabilities(gl, extensions, {});
            extensions.init(capabilities);
            this.webGLUtils = new THREE.WebGLUtils(gl, extensions, capabilities);
            if (this.enableDistancesComputationOnGPU && this.getSplatCount() > 0) {
                this.setupDistancesComputationTransformFeedback();
                this.updateGPUCentersBufferForDistancesComputation();
                this.updateGPUTransformIndexesBufferForDistancesComputation();
            }
        }
    }

    setupDistancesComputationTransformFeedback = function() {

        let currentRenderer;
        let currentMaxSplatCount;

        return function() {
            const maxSplatCount = this.getMaxSplatCount();

            if (!this.renderer) return;

            const rebuildGPUObjects = (currentRenderer !== this.renderer);
            const rebuildBuffers = currentMaxSplatCount !== maxSplatCount;

            if (!rebuildGPUObjects && !rebuildBuffers) return;

            if (rebuildGPUObjects) {
                this.disposeDistancesComputationGPUResources();
            } else if (rebuildBuffers) {
                this.disposeDistancesComputationGPUBufferResources();
            }

            const gl = this.renderer.getContext();

            const createShader = (gl, type, source) => {
                const shader = gl.createShader(type);
                if (!shader) {
                    console.error('Fatal error: gl could not create a shader object.');
                    return null;
                }

                gl.shaderSource(shader, source);
                gl.compileShader(shader);

                const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
                if (!compiled) {
                    let typeName = 'unknown';
                    if (type === gl.VERTEX_SHADER) typeName = 'vertex shader';
                    else if (type === gl.FRAGMENT_SHADER) typeName = 'fragement shader';
                    const errors = gl.getShaderInfoLog(shader);
                    console.error('Failed to compile ' + typeName + ' with these errors:' + errors);
                    gl.deleteShader(shader);
                    return null;
                }

                return shader;
            };

            let vsSource;
            if (this.integerBasedDistancesComputation) {
                vsSource =
                `#version 300 es
                in ivec4 center;
                flat out int distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint transformIndex;
                        uniform ivec4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            ivec4 transform = transforms[transformIndex];
                            distance = center.x * transform.x + center.y * transform.y + center.z * transform.z + transform.w * center.w;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform ivec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            } else {
                vsSource =
                `#version 300 es
                in vec3 center;
                flat out float distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint transformIndex;
                        uniform mat4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            vec4 transformedCenter = transforms[transformIndex] * vec4(center, 1.0);
                            distance = transformedCenter.z;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform vec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            }

            const fsSource =
            `#version 300 es
                precision lowp float;
                out vec4 fragColor;
                void main(){}
            `;

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.vao = gl.createVertexArray();
            }

            gl.bindVertexArray(this.distancesTransformFeedback.vao);

            if (rebuildGPUObjects) {
                const program = gl.createProgram();
                const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
                const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
                if (!vertexShader || !fragmentShader) {
                    throw new Error('Could not compile shaders for distances computation on GPU.');
                }
                gl.attachShader(program, vertexShader);
                gl.attachShader(program, fragmentShader);
                gl.transformFeedbackVaryings(program, ['distance'], gl.SEPARATE_ATTRIBS);
                gl.linkProgram(program);

                const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
                if (!linked) {
                    const error = gl.getProgramInfoLog(program);
                    console.error('Fatal error: Failed to link program: ' + error);
                    gl.deleteProgram(program);
                    gl.deleteShader(fragmentShader);
                    gl.deleteShader(vertexShader);
                    throw new Error('Could not link shaders for distances computation on GPU.');
                }

                this.distancesTransformFeedback.program = program;
                this.distancesTransformFeedback.vertexShader = vertexShader;
                this.distancesTransformFeedback.vertexShader = fragmentShader;
            }

            gl.useProgram(this.distancesTransformFeedback.program);

            this.distancesTransformFeedback.centersLoc =
                gl.getAttribLocation(this.distancesTransformFeedback.program, 'center');
            if (this.dynamicMode) {
                this.distancesTransformFeedback.transformIndexesLoc =
                    gl.getAttribLocation(this.distancesTransformFeedback.program, 'transformIndex');
                for (let i = 0; i < this.scenes.length; i++) {
                    this.distancesTransformFeedback.transformsLocs[i] =
                        gl.getUniformLocation(this.distancesTransformFeedback.program, `transforms[${i}]`);
                }
            } else {
                this.distancesTransformFeedback.modelViewProjLoc =
                    gl.getUniformLocation(this.distancesTransformFeedback.program, 'modelViewProj');
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.centersBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
                if (this.integerBasedDistancesComputation) {
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
                } else {
                    gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 3, gl.FLOAT, false, 0, 0);
                }

                if (this.dynamicMode) {
                    this.distancesTransformFeedback.transformIndexesBuffer = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);
                    gl.enableVertexAttribArray(this.distancesTransformFeedback.transformIndexesLoc);
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.transformIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
                }
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.outDistancesBuffer = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, maxSplatCount * 4, gl.STATIC_READ);

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.id = gl.createTransformFeedback();
            }
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            if (currentProgram) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            currentRenderer = this.renderer;
            currentMaxSplatCount = maxSplatCount;
        };

    }();

    /**
     * Refresh GPU buffers used for computing splat distances with centers data from the scenes for this mesh.
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     */
    updateGPUCentersBufferForDistancesComputation(sinceLastBuild = false) {

        this.checkForMultiSceneUpdateCondition(sinceLastBuild, 'updateGPUCentersBufferForDistancesComputation', 'sinceLastBuild');

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        const ArrayType = this.integerBasedDistancesComputation ? Uint32Array : Float32Array;
        const subBufferOffset = sinceLastBuild ? this.lastBuildSplatCount * 16 : 0;
        const srcCenters = this.integerBasedDistancesComputation ?
                           this.getIntegerCenters(true, sinceLastBuild) :
                           this.getFloatCenters(false, sinceLastBuild);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);

        if (sinceLastBuild) {
            gl.bufferSubData(gl.ARRAY_BUFFER, subBufferOffset, srcCenters);
        } else {
            const maxArray = new ArrayType(this.getMaxSplatCount() * 16);
            maxArray.set(srcCenters);
            gl.bufferData(gl.ARRAY_BUFFER, maxArray, gl.STATIC_DRAW);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Refresh GPU buffers used for pre-computing splat distances with centers data from the scenes for this mesh.
     */
    updateGPUTransformIndexesBufferForDistancesComputation() {

        if (!this.renderer || !this.dynamicMode) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.getTransformIndexes(), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Get a typed array containing a mapping from global splat indexes to their scene index.
     * @return {Uint32Array}
     */
    getTransformIndexes() {
        const transformIndexes = new Uint32Array(this.globalSplatIndexToSceneIndexMap.length);
        transformIndexes.set(this.globalSplatIndexToSceneIndexMap);
        return transformIndexes;
    }

    /**
     * Fill 'array' with the transforms for each scene in this splat mesh.
     * @param {Array} array Empty array to be filled with scene transforms. If not empty, contents will be overwritten.
     */
    fillTransformsArray = function() {

        const tempArray = [];

        return function(array) {
            if (tempArray.length !== array.length) tempArray.length = array.length;
            for (let i = 0; i < this.scenes.length; i++) {
                const sceneTransform = this.getScene(i).transform;
                const sceneTransformElements = sceneTransform.elements;
                for (let j = 0; j < 16; j++) {
                    tempArray[i * 16 + j] = sceneTransformElements[j];
                }
            }
            array.set(tempArray);
        };

    }();

    computeDistancesOnGPU = function() {

        const tempMatrix = new THREE.Matrix4();

        return function(modelViewProjMatrix, outComputedDistances) {
            if (!this.renderer) return;

            // console.time("gpu_compute_distances");
            const gl = this.renderer.getContext();

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);

            gl.bindVertexArray(this.distancesTransformFeedback.vao);
            gl.useProgram(this.distancesTransformFeedback.program);

            gl.enable(gl.RASTERIZER_DISCARD);

            if (this.dynamicMode) {
                for (let i = 0; i < this.scenes.length; i++) {
                    tempMatrix.copy(this.getScene(i).transform);
                    tempMatrix.premultiply(modelViewProjMatrix);

                    if (this.integerBasedDistancesComputation) {
                        const iTempMatrix = SplatMesh.getIntegerMatrixArray(tempMatrix);
                        const iTransform = [iTempMatrix[2], iTempMatrix[6], iTempMatrix[10], iTempMatrix[14]];
                        gl.uniform4i(this.distancesTransformFeedback.transformsLocs[i], iTransform[0], iTransform[1],
                                                                                        iTransform[2], iTransform[3]);
                    } else {
                        gl.uniformMatrix4fv(this.distancesTransformFeedback.transformsLocs[i], false, tempMatrix.elements);
                    }
                }
            } else {
                if (this.integerBasedDistancesComputation) {
                    const iViewProjMatrix = SplatMesh.getIntegerMatrixArray(modelViewProjMatrix);
                    const iViewProj = [iViewProjMatrix[2], iViewProjMatrix[6], iViewProjMatrix[10]];
                    gl.uniform3i(this.distancesTransformFeedback.modelViewProjLoc, iViewProj[0], iViewProj[1], iViewProj[2]);
                } else {
                    const viewProj = [modelViewProjMatrix.elements[2], modelViewProjMatrix.elements[6], modelViewProjMatrix.elements[10]];
                    gl.uniform3f(this.distancesTransformFeedback.modelViewProjLoc, viewProj[0], viewProj[1], viewProj[2]);
                }
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
            gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
            if (this.integerBasedDistancesComputation) {
                gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
            } else {
                gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 3, gl.FLOAT, false, 0, 0);
            }

            if (this.dynamicMode) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.transformIndexesBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.transformIndexesLoc);
                gl.vertexAttribIPointer(this.distancesTransformFeedback.transformIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
            }

            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, this.getSplatCount());
            gl.endTransformFeedback();

            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

            gl.disable(gl.RASTERIZER_DISCARD);

            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();

            const promise = new Promise((resolve) => {
                const checkSync = () => {
                    const timeout = 0;
                    const bitflags = 0;
                    const status = gl.clientWaitSync(sync, bitflags, timeout);
                    switch (status) {
                        case gl.TIMEOUT_EXPIRED:
                            return setTimeout(checkSync);
                        case gl.WAIT_FAILED:
                            throw new Error('should never get here');
                        default:
                            gl.deleteSync(sync);
                            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
                            gl.bindVertexArray(this.distancesTransformFeedback.vao);
                            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
                            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, outComputedDistances);
                            gl.bindBuffer(gl.ARRAY_BUFFER, null);

                            if (currentVao) gl.bindVertexArray(currentVao);

                            // console.timeEnd("gpu_compute_distances");

                            resolve();
                    }
                };
                setTimeout(checkSync);
            });

            if (currentProgram) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            return promise;
        };

    }();

    /**
     * Given a global splat index, return corresponding local data (splat buffer, index of splat in that splat
     * buffer, and the corresponding transform)
     * @param {number} globalIndex Global splat index
     * @param {object} paramsObj Object in which to store local data
     * @param {boolean} returnSceneTransform By default, the transform of the scene to which the splat at 'globalIndex' belongs will be
     *                                       returned via the 'sceneTransform' property of 'paramsObj' only if the splat mesh is static.
     *                                       If 'returnSceneTransform' is true, the 'sceneTransform' property will always contain the scene
     *                                       transform, and if 'returnSceneTransform' is false, the 'sceneTransform' property will always
     *                                       be null.
     */
    getLocalSplatParameters(globalIndex, paramsObj, returnSceneTransform) {
        if (returnSceneTransform === undefined || returnSceneTransform === null) {
            returnSceneTransform = this.dynamicMode ? false : true;
        }
        paramsObj.splatBuffer = this.getSplatBufferForSplat(globalIndex);
        paramsObj.localIndex = this.getSplatLocalIndex(globalIndex);
        paramsObj.sceneTransform = returnSceneTransform ? this.getSceneTransformForSplat(globalIndex) : null;
    }

    /**
     * Fill arrays with splat data and apply transforms if appropriate. Each array is optional.
     * @param {Float32Array} covariances Target storage for splat covariances
     * @param {Float32Array} centers Target storage for splat centers
     * @param {Uint8Array} colors Target storage for splat colors
     * @param {boolean} applySceneTransform By default, scene transforms are applied to relevant splat data only if the splat mesh is
     *                                      static. If 'applySceneTransform' is true, scene transforms will always be applied and if
     *                                      it is false, they will never be applied. If undefined, the default behavior will apply.
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     * @param {boolean} forceDestFromZero Force destination index to start at 0.
     */
    fillSplatDataArrays(covariances, centers, colors, applySceneTransform = undefined, sinceLastBuild, forceDestFromZero) {

        this.checkForMultiSceneUpdateCondition(sinceLastBuild, 'fillSplatDataArrays', 'sinceLastBuild');

        let destfrom = 0;
        for (let i = 0; i < this.scenes.length; i++) {
            if (applySceneTransform === undefined || applySceneTransform === null) {
                applySceneTransform = this.dynamicMode ? false : true;
            }

            let localDestFrom = destfrom;
            let srcFrom;
            let srcTo;
            if (sinceLastBuild) {
                srcFrom = this.lastBuildSplatCount[i];
                localDestFrom = forceDestFromZero ? 0 : srcFrom;
            }

            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            const sceneTransform = applySceneTransform ? scene.transform : null;
            if (covariances) {
                splatBuffer.fillSplatCovarianceArray(covariances, sceneTransform,
                                                     srcFrom, srcTo, localDestFrom, this.halfPrecisionCovariancesOnGPU ? 1 : 0);
            }
            if (centers) splatBuffer.fillSplatCenterArray(centers, sceneTransform, srcFrom, srcTo, localDestFrom);
            if (colors) splatBuffer.fillSplatColorArray(colors, sceneTransform, srcFrom, srcTo, localDestFrom);
            destfrom += splatBuffer.getSplatCount();
        }
    }

    /**
     * Convert splat centers, which are floating point values, to an array of integers and multiply
     * each by 1000. Centers will get transformed as appropriate before conversion to integer.
     * @param {number} padFour Enforce alignement of 4 by inserting a 1000 after every 3 values
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     * @return {Int32Array}
     */
    getIntegerCenters(padFour = false, sinceLastBuild = false) {

        this.checkForMultiSceneUpdateCondition(sinceLastBuild, 'getIntegerCenters', 'sinceLastBuild');

        const splatCount = this.getSplatCount();
        const fillCount = sinceLastBuild ? splatCount - this.lastBuildSplatCount[0] : splatCount;
        const floatCenters = new Float32Array(fillCount * 3);
        this.fillSplatDataArrays(null, floatCenters, null, undefined, sinceLastBuild, sinceLastBuild);
        let intCenters;
        let componentCount = padFour ? 4 : 3;
        intCenters = new Int32Array(fillCount * componentCount);
        for (let i = 0; i < fillCount; i++) {
            for (let t = 0; t < 3; t++) {
                intCenters[i * componentCount + t] = Math.round(floatCenters[i * 3 + t] * 1000.0);
            }
            if (padFour) intCenters[i * componentCount + 3] = 1000;
        }
        return intCenters;
    }


    /**
     * Returns an array of splat centers, transformed as appropriate, optionally padded.
     * @param {number} padFour Enforce alignement of 4 by inserting a 1 after every 3 values
     * @param {boolean} sinceLastBuild Specify whether or not to only update for splats that have been added since the last build.
     * @return {Float32Array}
     */
    getFloatCenters(padFour = false, sinceLastBuild = false) {

        this.checkForMultiSceneUpdateCondition(sinceLastBuild, 'getFloatCenters', 'sinceLastBuild');

        const splatCount = this.getSplatCount();
        const fillCount = sinceLastBuild ? splatCount - this.lastBuildSplatCount[0] : splatCount;
        this.fillSplatDataArrays(null, floatCenters, null, undefined, sinceLastBuild, sinceLastBuild);
        const floatCenters = new Float32Array(fillCount * 3);
        if (!padFour) return floatCenters;
        let paddedFloatCenters = new Float32Array(fillCount * 4);
        for (let i = 0; i < fillCount; i++) {
            for (let t = 0; t < 3; t++) {
                paddedFloatCenters[i * 4 + t] = floatCenters[i * 3 + t];
            }
            paddedFloatCenters[i * 4 + 3] = 1;
        }
        return paddedFloatCenters;
    }

    /**
     * Get the center for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outCenter THREE.Vector3 instance in which to store splat center
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat center. If 'applySceneTransform' is true,
     *                                      the scene transform will always be applied and if 'applySceneTransform' is false, the
     *                                      scene transform will never be applied. If undefined, the default behavior will apply.
     */
    getSplatCenter = function() {

        const paramsObj = {};

        return function(globalIndex, outCenter, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            paramsObj.splatBuffer.getSplatCenter(paramsObj.localIndex, outCenter, paramsObj.sceneTransform);
        };

    }();

    /**
     * Get the scale and rotation for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outScale THREE.Vector3 instance in which to store splat scale
     * @param {THREE.Quaternion} outRotation THREE.Quaternion instance in which to store splat rotation
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat scale and rotation. If
     *                                      'applySceneTransform' is true, the scene transform will always be applied and if
     *                                      'applySceneTransform' is false, the scene transform will never be applied. If undefined,
     *                                      the default behavior will apply.
     */
    getSplatScaleAndRotation = function() {

        const paramsObj = {};

        return function(globalIndex, outScale, outRotation, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            paramsObj.splatBuffer.getSplatScaleAndRotation(paramsObj.localIndex, outScale, outRotation, paramsObj.sceneTransform);
        };

    }();

    /**
     * Get the color for a splat.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector4} outColor THREE.Vector4 instance in which to store splat color
     */
    getSplatColor = function() {

        const paramsObj = {};

        return function(globalIndex, outColor) {
            this.getLocalSplatParameters(globalIndex, paramsObj);
            paramsObj.splatBuffer.getSplatColor(paramsObj.localIndex, outColor, paramsObj.sceneTransform);
        };

    }();

    /**
     * Store the transform of the scene at 'sceneIndex' in 'outTransform'.
     * @param {number} sceneIndex Index of the desired scene
     * @param {THREE.Matrix4} outTransform Instance of THREE.Matrix4 in which to store the scene's transform
     */
    getSceneTransform(sceneIndex, outTransform) {
        const scene = this.getScene(sceneIndex);
        scene.updateTransform();
        outTransform.copy(scene.transform);
    }

    /**
     * Get the scene at 'sceneIndex'.
     * @param {number} sceneIndex Index of the desired scene
     * @return {SplatScene}
     */
    getScene(sceneIndex) {
        if (sceneIndex < 0 || sceneIndex >= this.scenes.length) {
            throw new Error('SplatMesh::getScene() -> Invalid scene index.');
        }
        return this.scenes[sceneIndex];
    }

    getSplatBufferForSplat(globalIndex) {
        return this.getScene(this.globalSplatIndexToSceneIndexMap[globalIndex]).splatBuffer;
    }

    getSceneIndexForSplat(globalIndex) {
        return this.globalSplatIndexToSceneIndexMap[globalIndex];
    }

    getSceneTransformForSplat(globalIndex) {
        return this.getScene(this.globalSplatIndexToSceneIndexMap[globalIndex]).transform;
    }

    getSplatLocalIndex(globalIndex) {
        return this.globalSplatIndexToLocalSplatIndexMap[globalIndex];
    }

    static getIntegerMatrixArray(matrix) {
        const matrixElements = matrix.elements;
        const intMatrixArray = [];
        for (let i = 0; i < 16; i++) {
            intMatrixArray[i] = Math.round(matrixElements[i] * 1000.0);
        }
        return intMatrixArray;
    }

    checkForMultiSceneUpdateCondition(sinceLastBuild, functionName, parameterName) {
        if (this.scenes.length > 1 && sinceLastBuild) {
            throw new Error(`${functionName}() -> '${parameterName}' cannot be true if splat mesh has more than one scene.`);
        }
    }
}
