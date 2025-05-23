export type LocalFileStatus = "deleted" | "created" | "changed"
export type RemoteChangeType = "ADDED" | "MODIFIED" | "REMOVED"

export type LocalChange = {
    path: string,
    status: LocalFileStatus,
}

export type LocalUpdate = {
    localChanges: LocalChange[],
    // localTreeSha: Record<string, string>,
    parentCommitSha: string
}

export type RemoteChange = {
    path: string,
    status: RemoteChangeType,
    currentSha?: string
}

export type RemoteUpdate = {
    remoteChanges: RemoteChange[],
    remoteTreeSha: Record<string, string>, 
    latestRemoteCommitSha: string,
    clashedFiles: Array<ClashStatus>
}

export type ClashStatus = {
    path: string
    localStatus: LocalFileStatus
    remoteStatus: RemoteChangeType
}

export type ConflictReport = {
    path: string
    resolutionStrategy: "utf-8"
    localContent: string
    remoteContent: string
} | { 
    resolutionStrategy: "binary", 
    path: string, 
    remoteContent: string 
}

export type ConflictResolutionResult = {
    path: string
    noDiff: boolean
    fileOp?: FileOpRecord
}

export type FileOpRecord = {
    path: string
    status: LocalFileStatus
}
