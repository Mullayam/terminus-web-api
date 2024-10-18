export interface FileOperationPayload {
    oldPath?: string;
    newPath?: string;
    filePath?: string;
    folderPath?: string;
    dirPath?: string;
    path?: string;
}

export interface UploadedFile {
    name: string;
    data: Buffer;
}