import {FitSettings, LocalStores} from "main"
import {Octokit} from "@octokit/core"
import {compareSha} from "./utils"
import {VaultOperations} from "./vaultOps"
import {LocalChange, LocalFileStatus, RemoteChange, RemoteChangeType} from "./fitTypes"
import {arrayBufferToBase64} from "obsidian"
import Encryption from "./encryption";

export type TreeNode = {
    path: string, 
    mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined, 
    type: "commit" | "blob" | "tree" | undefined, 
    sha: string | null}

type OctokitCallMethods = {
    getUser: () => Promise<{owner: string, avatarUrl: string}>
    getRepos: () => Promise<string[]>
    getRef: (ref: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<TreeNode[]>
    getCommitTreeSha: (ref: string) => Promise<string>
    getRemoteTreeSha: (tree_sha: string) => Promise<{[k:string]: string}>
    createBlob: (content: string, encoding: string) =>Promise<string>
    createTreeNodeFromFile: ({path, status}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
    createCommit: (treeSha: string, parentSha: string) =>Promise<string>
    updateRef: (sha: string, ref: string) => Promise<string>
    getBlob: (file_sha:string) =>Promise<string>
}

export interface IFit extends OctokitCallMethods{
    owner: string
    repo: string
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
    fileSha1: (path: string) => Promise<string>
}

// Define a custom HttpError class that extends Error
export class OctokitHttpError extends Error {
    status: number;
    source: keyof OctokitCallMethods

    constructor(message: string, status: number, source: keyof OctokitCallMethods) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.source = source
    }
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
    encryption: Encryption

    constructor(setting: FitSettings, localStores: LocalStores, vaultOps: VaultOperations, encryption: Encryption) {
        this.loadSettings(setting)
        this.loadLocalStore(localStores)
		this.encryption = encryption;
        this.vaultOps = vaultOps
        this.headers = {
            // Hack to disable caching which leads to inconsistency for
            // read after write https://github.com/octokit/octokit.js/issues/890
            "If-None-Match": '', 
            'X-GitHub-Api-Version': '2022-11-28'
        }
    }
    
    loadSettings(setting: FitSettings) {
        this.owner = setting.owner
        this.repo = setting.repo
        this.branch = setting.branch
        this.deviceName = setting.deviceName
        this.octokit = new Octokit({auth: setting.pat})
    }
    
    loadLocalStore(localStore: LocalStores) {
        this.localSha = localStore.localSha
        this.lastFetchedCommitSha = localStore.lastFetchedCommitSha
        this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha
    }
    
    async fileSha1(fileContent: string): Promise<string> {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent))
        const hashArray = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    async computeFileLocalSha(path: string): Promise<string> {
        // Note: only support TFile now, investigate need for supporting TFolder later on
        const file = await this.vaultOps.getTFile(path)
		const content = arrayBufferToBase64(await this.vaultOps.vault.readBinary(file))
		return await this.fileSha1(path + content)
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.vaultOps.vault.getFiles().map(f=>{
            // ignore local files in the _fit/ directory
            return f.path.startsWith("_fit/") ? null : f.path
        }).filter(Boolean)
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.computeFileLocalSha(p)]
				})
			)
		)
	}

    async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
        const remoteCommitSha = await this.getLatestRemoteCommitSha()
        return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha}
    }

    async getLocalChanges(currentLocalSha?: Record<string, string>): Promise<LocalChange[]> {
        if (!currentLocalSha) {
            currentLocalSha = await this.computeLocalSha()
        }
        const localChanges = compareSha(currentLocalSha, this.localSha, "local")
        return localChanges
    }

    async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
        const remoteChanges = compareSha(remoteTreeSha, this.lastFetchedRemoteSha, "remote")
        return remoteChanges
    }

    getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}> {
        const localChangePaths = localChanges.map(c=>c.path)
        const remoteChangePaths = remoteChanges.map(c=>c.path)
        const clashedFiles = localChangePaths.map(
            (path, localIndex) => {
                const remoteIndex = remoteChangePaths.indexOf(path)
                if (remoteIndex !== -1) {
                    return {path, localIndex, remoteIndex}
                }
                return null
            }).filter(Boolean) as Array<{path: string, localIndex: number, remoteIndex:number}>
        return clashedFiles.map(
            ({path, localIndex, remoteIndex}) => {
                return {
                    path,
                    localStatus: localChanges[localIndex].status,
                    remoteStatus: remoteChanges[remoteIndex].status
                }
            })
    }

    async getUser(): Promise<{owner: string, avatarUrl: string}> {
        try {
            const {data: response} = await this.octokit.request(
                `GET /user`, {
                    headers: this.headers
            })
            return {owner: response.login, avatarUrl:response.avatar_url}
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getUser");
        }
    }

    async getRepos(): Promise<string[]> {
        const allRepos: string[] = [];
        let page = 1;
        const perPage = 100; // Set to the maximum value of 100

        try {
            let hasMorePages = true;
            while (hasMorePages) {
                const { data: response } = await this.octokit.request(
                    `GET /user/repos`, {
                    affiliation: "owner",
                    headers: this.headers,
                    per_page: perPage, // Number of repositories to import per page (up to 100)
                    page: page
                }
                );
                allRepos.push(...response.map(r => r.name));

                // Make sure you have the following pages
                if (response.length < perPage) {
                    hasMorePages = false; // Exit when there are no more repositories
                }

                page++; // Go to the next page
            }

            return allRepos;
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRepos");
        }
    }

    async getBranches(): Promise<string[]> {
        try {
            const {data: response} = await this.octokit.request(
                `GET /repos/{owner}/{repo}/branches`, 
                {
                    owner: this.owner,
                    repo: this.repo,
                    headers: this.headers
            })
            return response.map(r => r.name)
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRepos");
        }
    }

    async getRef(ref: string): Promise<string> {
        try {
            const {data: response} = await this.octokit.request(
                `GET /repos/{owner}/{repo}/git/ref/{ref}`, {
                    owner: this.owner,
                    repo: this.repo,
                    ref: ref,
                    headers: this.headers
            })
            return response.object.sha
        } catch (error) {
            throw new OctokitHttpError(error.message, error.status, "getRef");
        }
    }

    // Get the sha of the latest commit in the default branch (set by user in setting)
    async getLatestRemoteCommitSha(ref = `heads/${this.branch}`): Promise<string> {
        return await this.getRef(ref)
    }

    // ref Can be a commit SHA, branch name (heads/BRANCH_NAME), or tag name (tags/TAG_NAME), 
    // refers to https://git-scm.com/book/en/v2/Git-Internals-Git-References
    async getCommitTreeSha(ref: string): Promise<string> {
        const {data: commit} =  await this.octokit.request( 
            `GET /repos/{owner}/{repo}/commits/{ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            headers: this.headers
        })
        return commit.commit.tree.sha
    }

    async getTree(tree_sha: string): Promise<TreeNode[]> {
        const { data: tree } =  await this.octokit.request(
            `GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
            owner: this.owner,
            repo: this.repo,
            tree_sha,
            recursive: 'true',
            headers: this.headers
        })
		const arr = tree.tree as TreeNode[];
		for (const node of arr) {
			try {
				node.path = await this.encryption.decryptPath(node.path);
			} catch (e) {
				console.error('Path decryption failed, skipping', e);
			}
		}
        return arr;
    }

    // get the remote tree sha in the format compatible with local store
    async getRemoteTreeSha(tree_sha: string): Promise<{[k:string]: string}> {
        const remoteTree = await this.getTree(tree_sha)
        const remoteSha = Object.fromEntries(remoteTree.map((node: TreeNode) : [string, string] | null=>{
            // currently ignoring directory changes, if you'd like to upload a new directory, 
            // a quick hack would be creating an empty file inside
            if (node.type=="blob") {
                if (!node.path || !node.sha) {
                    throw new Error("Path or sha not found for blob node in remote");
                }
                // ignore changes in the _fit/ directory
                if (node.path.startsWith("_fit/")) {return null}
                return [node.path, node.sha]
            }
            return null
        }).filter(Boolean) as [string, string][])
        return remoteSha
    }

    async createBlob(content: string, encoding: string): Promise<string> {
		const encrypted = await this.encryption.encrypt(content);
        const {data: blob} = await this.octokit.request(
            `POST /repos/{owner}/{repo}/git/blobs`, {
            owner: this.owner,
            repo: this.repo,
			content: encrypted,
            encoding,
            headers: this.headers
        })
        return blob.sha
    }


    async createTreeNodeFromFile({path, status}: LocalChange, remoteTree: Array<TreeNode>): Promise<TreeNode|null> {
		if (status === "deleted") {
            // skip creating deletion node if file not found on remote
            if (remoteTree.every(node => node.path !== path)) {
                return null
            }
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			}
		}
        const file = await this.vaultOps.getTFile(path)
		const fileArrayBuf = await this.vaultOps.vault.readBinary(file);
		const uint8Array = new Uint8Array(fileArrayBuf);
		let binaryString = '';
		for (let i = 0; i < uint8Array.length; i++) {
			binaryString += String.fromCharCode(uint8Array[i]);
		}

		const content = btoa(binaryString);
		const encoding = 'base64';
		// const encoding = 'utf-8';

		const blobSha = await this.createBlob(content, encoding)
        // skip creating node if file found on remote is the same as the created blob
        if (remoteTree.some(node => node.path === path && node.sha === blobSha)) {
            return null
        }
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		}
	}

    async createTree(
        treeNodes: Array<TreeNode>,
        base_tree_sha: string): 
        Promise<string> {
			for (const node of treeNodes) {
				node.path = await this.encryption.encryptPath(node.path);
			}
            const {data: newTree} = await this.octokit.request(
                `POST /repos/{owner}/{repo}/git/trees`, 
                {
                    owner: this.owner,
                    repo: this.repo,
                    tree: treeNodes,
                    base_tree: base_tree_sha,
                    headers: this.headers
                }
            )
            return newTree.sha
    }

    async createCommit(treeSha: string, parentSha: string): Promise<string> {
        const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`
        const { data: createdCommit } = await this.octokit.request(
            `POST /repos/{owner}/{repo}/git/commits` , {
            owner: this.owner,
            repo: this.repo,
            message,
            tree: treeSha,
            parents: [parentSha],
            headers: this.headers
        })
        return createdCommit.sha
    }

    async updateRef(sha: string, ref = `heads/${this.branch}`): Promise<string> {
        const { data:updatedRef } = await this.octokit.request(
            `PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
            owner: this.owner,
            repo: this.repo,
            ref,
            sha,
            headers: this.headers
        })
        return updatedRef.object.sha
    }

    async getBlob(file_sha:string): Promise<string> {
        const res = await this.octokit.request(
            `GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
            owner: this.owner,
            repo: this.repo,
            file_sha,
            headers: this.headers
        })
		try {
			const data = res.data.content.replace(/\n/g, '');
			return await this.encryption.decrypt(data);
		} catch (e) {
			console.error('Decryption failed, skipping', e);
			return res.data.content;
		}
    }
}
