// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Backend } from '@zenfs/core';
import { Inode } from '@zenfs/core';
import { basename, dirname, join } from '@zenfs/core/path.js';
import { S_IFDIR, S_IFREG } from '@zenfs/core/vfs/constants.js';
import { withErrno, type Exception } from 'kerium';
import { encodeASCII } from 'utilium';
import { CloudFS, type CloudFSOptions } from './cloudfs.js';

type DriveError = Error & { code?: number };

function convertError(error: DriveError): Exception {
	if (!error.code) {
		return withErrno('EIO', error.message);
	}

	switch (error.code) {
		case 404:
			return withErrno('ENOENT');
		case 403:
			return withErrno('EACCES');
		case 400:
			return withErrno('EINVAL');
		case 409:
			return withErrno('EEXIST');
		default:
			return withErrno('EIO', error.message);
	}
}

export class GoogleDriveFS extends CloudFS<DriveError> {
	private pathCache: Map<string, string> = new Map();
	private nodeCache: Map<string, Inode> = new Map();
	private dirCache: Map<string, string[]> = new Map();

	public constructor(
		/**
		 * A fully authenticated Google APIs client.
		 */
		protected drive: typeof gapi.client.drive,
		cacheTTL?: number
	) {
		super(0x67647276, 'nfs-google-drive', cacheTTL, convertError);
		this.pathCache.set('/', 'root');
	}

	private clearCaches(path: string) {
		this.pathCache.delete(path);
		this.nodeCache.delete(path);
		this.dirCache.delete(dirname(path));
	}

	private async getFileId(path: string): Promise<string> {
		const cachedId = this.pathCache.get(path);
		if (cachedId) return cachedId;

		if (path === '/') return 'root';

		const segments = path.split('/').filter(v => v);
		let parentId: string | undefined = 'root';
		let fileId: string | undefined = 'root';
		let currentPath = '';

		for (const segment of segments) {
			currentPath += '/' + segment;

			const cachedPartialId = this.pathCache.get(currentPath);
			if (cachedPartialId) {
				parentId = fileId;
				fileId = cachedPartialId;
				continue;
			}

			// Don't encode the query, use the raw segment name
			const response = await this.drive.files.list({
				q: `name = '${segment}' and '${parentId}' in parents and trashed = false`,
				fields: 'files(id, name, mimeType)',
				spaces: 'drive',
			});

			const { files } = response.result;
			if (!files || files.length === 0) throw withErrno('ENOENT');

			parentId = fileId;
			fileId = files[0].id!;
			this.pathCache.set(currentPath, fileId);
		}

		return fileId;
	}

	protected async _move(from: string, to: string): Promise<void> {
		const name = basename(to);
		await this.drive.files.update({ fileId: await this.getFileId(from), resource: { name } });
		this.clearCaches(from);
		this.clearCaches(to);
	}

	// Update other methods to use normalizePath
	protected async _stat(path: string): Promise<Inode> {
		const cachedStats = this.nodeCache.get(path);
		if (cachedStats) return cachedStats;

		const { result } = await this.drive.files.get({
			fileId: await this.getFileId(path),
			fields: 'mimeType, size, modifiedTime',
		});

		const isDirectory = result.mimeType === 'application/vnd.google-apps.folder';

		const inode = new Inode({
			mode: isDirectory ? S_IFDIR | 0o777 : S_IFREG | 0o666,
			size: parseInt(result.size!),
			mtimeMs: new Date(result.modifiedTime!).getTime(),
			atimeMs: Date.now(),
		});

		this.nodeCache.set(path, inode);
		return inode;
	}

	protected async _create(path: string, inode: Inode): Promise<void> {
		const { result } = await this.drive.files.create({
			resource: {
				name: basename(path),
				mimeType: 'application/' + (inode.mode & S_IFDIR ? 'vnd.google-apps.folder' : 'octet-stream'),
				// @ts-expect-error 2353
				media:
					inode.mode & S_IFDIR
						? undefined
						: { body: new Uint8Array(0), mimeType: 'application/octet-stream' },
			},
			fields: 'id',
		});

		this.pathCache.set(path, result.id!);
		this.nodeCache.set(path, inode);
		this.clearCaches(dirname(path));
	}

	protected async _delete(path: string): Promise<void> {
		try {
			await this.drive.files.delete({ fileId: await this.getFileId(path) });
			this.clearCaches(path);
		} catch (error) {
			throw convertError(error as DriveError);
		}
	}

	public async readdir(path: string): Promise<string[]> {
		const cachedDir = this.dirCache.get(path);
		if (cachedDir) return cachedDir;

		try {
			const parentId = await this.getFileId(path);
			const response = await this.drive.files.list({
				q: `'${parentId}' in parents and trashed = false`,
				fields: 'files(id, name, mimeType)',
				spaces: 'drive',
				pageSize: 1000,
			});

			const files = (response.result.files || ([] as gapi.client.drive.File[])).map(file => {
				this.pathCache.set(join(path, file.name!), file.id!);
				return file.name!; // Return the raw name
			});

			this.dirCache.set(path, files);
			return files;
		} catch (error) {
			throw convertError(error as DriveError);
		}
	}

	protected async _read(path: string): Promise<Uint8Array> {
		const fileId = await this.getFileId(path);

		// First get the file metadata to check its type
		const metadata = await this.drive.files.get({ fileId, fields: 'mimeType, size' });

		// If it's a Google Doc, we need to export it
		const isGoogleDoc = metadata.result.mimeType?.startsWith('application/vnd.google-apps.');

		const result = isGoogleDoc
			? await this.drive.files.export({ fileId, mimeType: 'text/plain' })
			: await this.drive.files.get({ fileId, alt: 'media' });

		return encodeASCII(result.body);
	}

	protected async _write(path: string, body: Uint8Array): Promise<void> {
		await this.drive.files.update({
			fileId: await this.getFileId(path),
			resource: { name: path.split('/').pop(), mimeType: 'application/octet-stream' },
			// @ts-expect-error 2353
			media: { mimeType: 'application/octet-stream', body },
		});

		this.clearCaches(path);
	}
}

export interface GoogleDriveOptions extends CloudFSOptions {
	drive: typeof gapi.client.drive;
}

export const GoogleDrive = {
	name: 'GoogleDrive',

	options: {
		drive: { type: 'object', required: true },
		cacheTTL: { type: 'number', required: false },
	},

	isAvailable(): boolean {
		return true;
	},

	create(options: GoogleDriveOptions) {
		return new GoogleDriveFS(options.drive, options.cacheTTL);
	},
} satisfies Backend<GoogleDriveFS, GoogleDriveOptions>;
