import { SplatBuffer } from './SplatBuffer.js';
import { fetchWithProgress } from '../Util.js';


let fetchWorker;
function fetchWorkerFunc(self) {

    function fetchFile(path) {
        console.log(path)
    }

    self.onmessage = (e) => {
        if (e.data.init) {

        } else if (e.data.fetch) {
            fetchFile(e.data.fetch.path);
        }
    };
}

function workerFetchFile(path) {
    fetchWorker.postMessage({
        'fetch': {
            'path': path
        }
    });
}

function checkAndCreateFetchWorker() {
    if (!fetchWorker) {
        fetchWorker = new Worker(
            URL.createObjectURL(
                new Blob(['(', fetchWorkerFunc.toString(), ')(self)'], {
                    type: 'application/javascript',
                }),
            ),
        );
        fetchWorker.postMessage({
            'init': {}
        });
    }
}

export class KSplatLoader {

    constructor(splatBuffer = null) {
        this.splatBuffer = splatBuffer;
        this.downLoadLink = null;
    }

    loadFromURL(fileName, onProgress, streamBuiltSections, onSectionBuilt) {
        let bytesLoaded = 0;
        let totalStorageSizeBytes = 0;

        let fullBuffer;
        let fullSplatBuffer;

        let headerBuffer;
        let header;
        let headerLoaded = false;
        let headerLoading = false;

        let sectionHeadersBuffer;
        let sectionHeaders = [];
        let sectionHeadersLoaded = false;
        let sectionHeadersLoading = false;

        let sectionLoaded = {};
        let sectionCount = 0;

        let chunks = [];

        let sectionsLoadResolvePromise;
        let sectionsLoadPromise = new Promise((resolve) => {
            sectionsLoadResolvePromise = resolve;
        });

        const checkAndLoadHeader = () => {
            if (!headerLoaded && !headerLoading && bytesLoaded >= SplatBuffer.HeaderSizeBytes) {
                headerLoading = true;
                const headerAssemblyPromise = new Blob(chunks).arrayBuffer();
                headerAssemblyPromise.then((bufferData) => {
                    headerBuffer = new ArrayBuffer(SplatBuffer.HeaderSizeBytes);
                    new Uint8Array(headerBuffer).set(new Uint8Array(bufferData, 0, SplatBuffer.HeaderSizeBytes));
                    headerLoading = false;
                    headerLoaded = true;
                    header = SplatBuffer.parseHeader(headerBuffer);
                    checkAndLoadSectionHeaders();
                });
            }
        };

        const checkAndLoadSectionHeaders = () => {
            const performLoad = () => {
                sectionHeadersLoading = true;
                const sectionHeadersAssemblyPromise = new Blob(chunks).arrayBuffer();
                sectionHeadersAssemblyPromise.then((bufferData) => {
                    sectionHeadersLoading = false;
                    sectionHeadersLoaded = true;
                    sectionHeadersBuffer = new ArrayBuffer(header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes);
                    new Uint8Array(sectionHeadersBuffer).set(new Uint8Array(bufferData, SplatBuffer.HeaderSizeBytes,
                                                                            header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes));
                    sectionHeaders = SplatBuffer.parseSectionHeaders(header, sectionHeadersBuffer);
                    let totalSectionStorageStorageByes = 0;
                    for (let i = 0; i < header.maxSectionCount; i++) {
                        totalSectionStorageStorageByes += sectionHeaders[i].storageSizeBytes;
                    }
                    totalStorageSizeBytes = SplatBuffer.HeaderSizeBytes + header.maxSectionCount *
                                            SplatBuffer.SectionHeaderSizeBytes + totalSectionStorageStorageByes;
                    fullBuffer = new ArrayBuffer(totalStorageSizeBytes);
                    let offset = 0;
                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        new Uint8Array(fullBuffer, offset, chunk.byteLength).set(new Uint8Array(chunk));
                        offset += chunk.byteLength;
                    }
                    window.setTimeout(() => checkAndLoadSections(), 100);
                });
            };

            if (!sectionHeadersLoading && !sectionHeadersLoaded && headerLoaded &&
                bytesLoaded >= SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount) {
                performLoad();
            }
        };

        const checkAndLoadSections = () => {
            if (sectionHeadersLoaded) {
                let byteOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount;
                for (let i = 0; i <= sectionCount && i < header.maxSectionCount; i++) byteOffset += sectionHeaders[i].storageSizeBytes;
                for (let i = sectionCount + 1; i <= header.maxSectionCount; i++) {
                    if (bytesLoaded >= byteOffset) {
                        const sectionToLoad = i - 1;
                        if (!sectionLoaded[sectionToLoad]) {
                            sectionLoaded[sectionToLoad] = true;
                            sectionCount++;

                            let splatCount = 0;
                            for (let s = 0; s < sectionCount; s++) {
                                splatCount += sectionHeaders[s].splatCount;
                            }

                            if (!fullSplatBuffer) fullSplatBuffer = new SplatBuffer(fullBuffer, false);
                            fullSplatBuffer.updateLoadedCounts(sectionCount, splatCount);

                            onSectionBuilt(fullSplatBuffer);

                            if (sectionCount >= header.maxSectionCount) {
                                sectionsLoadResolvePromise();
                            } else {
                                window.setTimeout(() => checkAndLoadSections(), 100);
                            }
                        }
                        if (i < header.maxSectionCount) byteOffset += sectionHeaders[i].storageSizeBytes;
                    }
                }
            }
        };

        const localOnProgress = (percent, percentStr, chunk) => {
            if (chunk) {
                chunks.push(chunk);
                if (fullBuffer) {
                    new Uint8Array(fullBuffer, bytesLoaded, chunk.byteLength).set(new Uint8Array(chunk));
                }
                bytesLoaded += chunk.byteLength;
            }
            if (streamBuiltSections) {
                checkAndLoadHeader();
                checkAndLoadSectionHeaders();
                checkAndLoadSections();
            }
            if (onProgress) onProgress(percent, percentStr, chunk);
        };
        return fetchWithProgress(fileName, localOnProgress).then((bufferData) => {
            if (streamBuiltSections) {
                return sectionsLoadPromise.then(() => {
                    return new SplatBuffer(bufferData);
                });
            } else {
                return new SplatBuffer(bufferData);
            }
        });
    }

    setFromBuffer(splatBuffer) {
        this.splatBuffer = splatBuffer;
    }

    static downloadFile = function() {

        let downLoadLink;

        return function(splatBuffer, fileName) {
            const blob = new Blob([splatBuffer.bufferData], {
                type: 'application/octet-stream',
            });

            if (!downLoadLink) {
                downLoadLink = document.createElement('a');
                document.body.appendChild(downLoadLink);
            }
            downLoadLink.download = fileName;
            downLoadLink.href = URL.createObjectURL(blob);
            downLoadLink.click();
        };

    }();

}