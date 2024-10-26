export interface SFTP_FILES_LIST {
    accessTime: number
    group: number
    longname: string
    modifyTime: number
    name: string
    owner: number
    rights: Rights
    size: number
    type: string
}

interface Rights {
    group: string
    other: string
    user: string
}
