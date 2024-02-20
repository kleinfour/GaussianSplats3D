import * as THREE from 'three';
import { SplatTreeNode } from './SplatTreeNode.js';

class SplatSubTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.sceneDimensions = new THREE.Vector3();
        this.sceneMin = new THREE.Vector3();
        this.sceneMax = new THREE.Vector3();
        this.rootNode = null;
        this.addedIndexes = {};
        this.nodesWithIndexes = [];
        this.splatMesh = null;
    }

    static convertWorkerSubTreeNode(workerSubTreeNode) {
        const minVector = new THREE.Vector3().fromArray(workerSubTreeNode.min);
        const maxVector = new THREE.Vector3().fromArray(workerSubTreeNode.max);
        const convertedNode = new SplatTreeNode(minVector, maxVector, workerSubTreeNode.depth, workerSubTreeNode.id);
        convertedNode.data = workerSubTreeNode.data;
        if (workerSubTreeNode.children) {
            for (let child of workerSubTreeNode.children) {
                convertedNode.children.push(SplatSubTree.convertWorkerSubTreeNode(child));
            }
        }
        return convertedNode;
    }

    static convertWorkerSubTree(workerSubTree, splatMesh) {
        const convertedSubTree = new SplatSubTree(workerSubTree.maxDepth, workerSubTree.maxCentersPerNode);
        convertedSubTree.sceneMin = new THREE.Vector3().fromArray(workerSubTree.sceneMin);
        convertedSubTree.sceneMax = new THREE.Vector3().fromArray(workerSubTree.sceneMax);
        convertedSubTree.addedIndexes = workerSubTree.addedIndexes;
        convertedSubTree.nodesWithIndexes = workerSubTree.nodesWithIndexes
        convertedSubTree.splatMesh = splatMesh;
        convertedSubTree.rootNode = SplatSubTree.convertWorkerSubTreeNode(workerSubTree.rootNode);
        return convertedSubTree;
    }
}

let splatTreeWorker;
function createSplatTreeWorker(self) {

    class WorkerBox3 {

        constructor(min, max) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
        }

        containsPoint(point) {
            return point[0] >= this.min[0] && point[0] <= this.max[0] &&
                   point[1] >= this.min[1] && point[1] <= this.max[1] && 
                   point[2] >= this.min[2] && point[2] <= this.max[2];
        }
    }

    class WorkerSplatSubTree {

        constructor(maxDepth, maxCentersPerNode) {
            this.maxDepth = maxDepth;
            this.maxCentersPerNode = maxCentersPerNode;
            this.sceneDimensions = [];
            this.sceneMin = [];
            this.sceneMax = [];
            this.rootNode = null;
            this.addedIndexes = {};
            this.nodesWithIndexes = [];
            this.splatMesh = null;
        }
    
    }

    class WorkerSplatTreeNode {
        static idGen = 0;
        constructor(min, max, depth, id) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
            this.center = [(max[0] - min[0]) * 0.5 + min[0],
                           (max[1] - min[1]) * 0.5 + min[1],
                           (max[2] - min[2]) * 0.5 + min[2]];
            this.depth = depth;
            this.children = [];
            this.data = null;
            this.id = id || WorkerSplatTreeNode.idGen++;
        }
    
    }

    processSplatTreeNode = function (tree, node, indexToCenter) {
        const splatCount = node.data.indexes.length;

        if (splatCount < tree.maxCentersPerNode || node.depth > tree.maxDepth) {
            const newIndexes = [];
            for (let i = 0; i < node.data.indexes.length; i++) {
                if (!tree.addedIndexes[node.data.indexes[i]]) {
                    newIndexes.push(node.data.indexes[i]);
                    tree.addedIndexes[node.data.indexes[i]] = true;
                }
            }
            node.data.indexes = newIndexes;
            tree.nodesWithIndexes.push(node);
            return;
        }

        const nodeDimensions = [node.max[0] - node.min[0],
                                node.max[1] - node.min[1],
                                node.max[2] - node.min[2]];
        const halfDimensions = [nodeDimensions[0] * 0.5,
                                nodeDimensions[1] * 0.5,
                                nodeDimensions[2] * 0.5];
        const nodeCenter = [node.min[0] + halfDimensions[0],
                            node.min[1] + halfDimensions[1],
                            node.min[2] + halfDimensions[2]];

        const childrenBounds = [
            // top section, clockwise from upper-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2] ],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),

            // bottom section, clockwise from lower-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
        ];

        const splatCounts = [];
        const baseIndexes = [];
        for (let i = 0; i < childrenBounds.length; i++) {
            splatCounts[i] = 0;
            baseIndexes[i] = [];
        }

        for (let i = 0; i < splatCount; i++) {
            const splatGlobalIndex = node.data.indexes[i];
            const center = indexToCenter[splatGlobalIndex];
            for (let j = 0; j < childrenBounds.length; j++) {
                if (childrenBounds[j].containsPoint(center)) {
                    splatCounts[j]++;
                    baseIndexes[j].push(splatGlobalIndex);
                }
            }
        }

        for (let i = 0; i < childrenBounds.length; i++) {
            const childNode = new WorkerSplatTreeNode(childrenBounds[i].min, childrenBounds[i].max, node.depth + 1);
            childNode.data = {
                'indexes': baseIndexes[i]
            };
            node.children.push(childNode);
        }

        node.data = {};
        for (let child of node.children) {
            processSplatTreeNode(tree, child, indexToCenter);
        }
        return;
    }

    const buildSubTree = (sceneCenters, maxDepth, maxCentersPerNode) => {

        const sceneMin = [0, 0, 0];
        const sceneMax = [0, 0, 0];
        const indexes = [];
        for ( let i = 0; i < sceneCenters.length; i ++) {
            const center = sceneCenters[i];
            if (i === 0 || center[0] < sceneMin[0]) sceneMin[0] = center[0];
            if (i === 0 || center[0] > sceneMax[0]) sceneMax[0] = center[0];
            if (i === 0 || center[1] < sceneMin[1]) sceneMin[1] = center[1];
            if (i === 0 || center[1] > sceneMax[1]) sceneMax[1] = center[1];
            if (i === 0 || center[2] < sceneMin[2]) sceneMin[2] = center[2];
            if (i === 0 || center[2] > sceneMax[2]) sceneMax[2] = center[2];
            indexes.push(center[3]);
        }
        const sceneDimensions = [sceneMax[0] - sceneMin[0], sceneMax[1] - sceneMin[1], sceneMax[2] - sceneMin[2]];
        const subTree = new WorkerSplatSubTree(maxDepth, maxCentersPerNode);
        subTree.sceneMin = sceneMin;
        subTree.sceneMax = sceneMax;
        subTree.rootNode = new WorkerSplatTreeNode(subTree.sceneMin, subTree.sceneMax, 0);
        subTree.rootNode.data = {
            'indexes': indexes
        };

        return subTree;
    };

    function createSplatTree(allCenters, maxDepth, maxCentersPerNode) {
        const indexToCenter = [];
        for (let sceneCenters of allCenters) {
            for ( let i = 0; i < sceneCenters.length; i ++) {
                const center = sceneCenters[i];
                indexToCenter[center[3]] = center;
            }
        }
        const subTrees = [];
        for (let sceneCenters of allCenters) {
            const subTree = buildSubTree(sceneCenters, maxDepth, maxCentersPerNode);
            subTrees.push(subTree);
            processSplatTreeNode(subTree, subTree.rootNode, indexToCenter);
        }
        self.postMessage({
            'subTrees': subTrees
        })
    }

    self.onmessage = (e) => {
        if (e.data.init) {

        } else if (e.data.process) {
            createSplatTree(e.data.process.centers, e.data.process.maxDepth, e.data.process.maxCentersPerNode);
        }
    };
}

function workerProcessCenters(centers, maxDepth, maxCentersPerNode) {
    splatTreeWorker.postMessage({
        'process': {
            'centers': centers,
            'maxDepth': maxDepth,
            'maxCentersPerNode': maxCentersPerNode
        }
    });
}

function checkAndCreateWorker() {
    if (!splatTreeWorker) {
        splatTreeWorker = new Worker(
            URL.createObjectURL(
                new Blob(['(', createSplatTreeWorker.toString(), ')(self)'], {
                    type: 'application/javascript',
                }),
            ),
        );
    
    
        splatTreeWorker.postMessage({
            'init': {}
        });
    }
} 

/**
 * SplatTree: Octree tailored to splat data from a SplatMesh instance
 */
export class SplatTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.subTrees = [];
        this.splatMesh = null;
    }

    processSplatMesh = function(splatMesh, filterFunc = () => true) {
        checkAndCreateWorker();

        this.splatMesh = splatMesh;
        this.subTrees = [];
        const center = new THREE.Vector3();

        const addCentersForScene = (splatOffset, splatCount) => {
            const sceneCenters = [];
            for (let i = 0; i < splatCount; i++) {
                const globalSplatIndex = i + splatOffset;
                if (filterFunc(globalSplatIndex)) {
                    splatMesh.getSplatCenter(globalSplatIndex, center);
                    sceneCenters.push([center.x, center.y, center.z, globalSplatIndex]);
                }
            }
            return sceneCenters;
        };

        return new Promise((resolve) => {
            const allCenters = [];
            if (splatMesh.dynamicMode) {
                let splatOffset = 0;
                for (let s = 0; s < splatMesh.scenes.length; s++) {
                    const scene = splatMesh.getScene(s);
                    const splatCount = scene.splatBuffer.getSplatCount();
                    const sceneCenters = addCentersForScene(splatOffset, splatCount);
                    allCenters.push(sceneCenters);
                    splatOffset += splatCount;
                }
            } else {
                const scene = splatMesh.getScene(0);
                const sceneCenters = addCentersForScene(0, scene.splatBuffer.getSplatCount());
                allCenters.push(sceneCenters);
            }

            splatTreeWorker.onmessage = (e) => {
                 if (e.data.subTrees) {
                    for (let workerSubTree of e.data.subTrees) {
                        const convertedSubTree = SplatSubTree.convertWorkerSubTree(workerSubTree, splatMesh);
                        this.subTrees.push(convertedSubTree);
                    }
                    resolve();
                }
            };
            workerProcessCenters(allCenters, this.maxDepth, this.maxCentersPerNode);
        });

    };

    countLeaves() {

        let leafCount = 0;
        this.visitLeaves(() => {
            leafCount++;
        });

        return leafCount;
    }

    visitLeaves(visitFunc) {

        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        for (let subTree of this.subTrees) {
            visitLeavesFromNode(subTree.rootNode, visitFunc);
        }
    }

}
