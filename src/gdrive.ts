import { Async, type Backend, Errno, ErrnoError, type File, FileSystem, PreloadFile, Stats } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/emulation/constants.js';
import { dirname, join } from '@zenfs/core/path';

import 'gapi';
import 'gapi.client.drive-v3';
type GapiClient = typeof gapi;

type DriveError = Error & { code?: number };

function convertError(error: DriveError, path: string, syscall: string): ErrnoError {
	if (!error.code) {
		return new ErrnoError(Errno.EIO, error.message, path, syscall);
	}

	switch (error.code) {
		case 404:
			return ErrnoError.With('ENOENT', path, syscall);
		case 403:
			return ErrnoError.With('EACCES', path, syscall);
		case 400:
			return ErrnoError.With('EINVAL', path, syscall);
		case 409:
			return ErrnoError.With('EEXIST', path, syscall);
		default:
			return new ErrnoError(Errno.EIO, error.message, path, syscall);
	}
}

export class GoogleDriveFS extends Async(FileSystem) {
	private pathCache: Map<string, string> = new Map();
	private statsCache: Map<string, Stats> = new Map();
	private dirCache: Map<string, string[]> = new Map();

	public constructor(
		/**
		 * A fully authenticated Google APIs client.
		 */
		protected gapi: GapiClient
	) {
		super();
		if (!gapi?.client?.drive) throw new ErrnoError(Errno.EINVAL, 'GAPI is missing Google Drive client library');

		this.pathCache.set('/', 'root');
	}

	private clearCaches(path: string) {
		this.pathCache.delete(path);
		this.statsCache.delete(path);
		this.dirCache.delete(dirname(path));
	}

	private getNameFromPath(path: string): string {
		return path.split('/').filter(Boolean).pop() || '';
	}

	private async getFileId(path: string): Promise<string> {
		path = this.normalizePath(path);
		const cachedId = this.pathCache.get(path);
		if (cachedId) return cachedId;

		try {
			if (path === '/') return 'root';

			const segments = path.split('/').filter(Boolean);
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
				const response = await this.gapi.client.drive.files.list({
					q: `name = '${segment}' and '${parentId}' in parents and trashed = false`,
					fields: 'files(id, name, mimeType)',
					spaces: 'drive',
				});

				const { files } = response.result;
				if (!files || files.length === 0) {
					throw ErrnoError.With('ENOENT', path, 'getFileId');
				}

				parentId = fileId;
				fileId = files[0].id!;
				this.pathCache.set(currentPath, fileId);
			}

			return fileId;
		} catch (error) {
			throw convertError(error as DriveError, path, 'getFileId');
		}
	}

	private decodePathComponent(component: string): string {
		try {
			return decodeURIComponent(component);
		} catch {
			return component;
		}
	}

	private normalizePath(path: string): string {
		// Split path, decode each component, and rejoin
		return path
			.split('/')
			.map(component => this.decodePathComponent(component))
			.join('/');
	}

	public async rename(oldPath: string, newPath: string): Promise<void> {
		try {
			const fileId = await this.getFileId(oldPath);
			const name = this.getNameFromPath(newPath);
			await this.gapi.client.drive.files.update({ fileId, resource: { name } });
			this.clearCaches(oldPath);
			this.clearCaches(newPath);
		} catch (error) {
			throw convertError(error as DriveError, oldPath, 'rename');
		}
	}

	// Update other methods to use normalizePath
	public async stat(path: string): Promise<Stats> {
		path = this.normalizePath(path);
		const cachedStats = this.statsCache.get(path);
		if (cachedStats) return cachedStats;

		try {
			if (path === '/') {
				const rootStats = new Stats({ mode: 0o777 | S_IFDIR });
				this.statsCache.set(path, rootStats);
				return rootStats;
			}

			const fileId = await this.getFileId(path);
			const response = await this.gapi.client.drive.files.get({
				fileId,
				fields: 'mimeType, size, modifiedTime',
			});

			const file = response.result;
			const isDirectory = file.mimeType === 'application/vnd.google-apps.folder';

			// Handle Google Docs files differently
			const isGoogleDoc = file.mimeType?.startsWith('application/vnd.google-apps.');
			const size = isGoogleDoc ? 0 : parseInt(file.size || '0');

			const stats = new Stats({
				mode: isDirectory ? S_IFDIR | 0o777 : S_IFREG | 0o666,
				size,
				mtimeMs: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now(),
				atimeMs: Date.now(),
			});

			this.statsCache.set(path, stats);
			return stats;
		} catch (error) {
			throw convertError(error as DriveError, path, 'stat');
		}
	}

	public async openFile(path: string, flag: string): Promise<File> {
		path = this.normalizePath(path);
		try {
			const fileId = await this.getFileId(path);

			// First get the file metadata to check its type
			const metadata = await this.gapi.client.drive.files.get({ fileId, fields: 'mimeType, size' });

			// If it's a Google Doc, we need to export it
			const isGoogleDoc = metadata.result.mimeType?.startsWith('application/vnd.google-apps.');

			const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + (isGoogleDoc ? '/export?mimeType=text/plain' : '?alt=media');
			const response = await fetch(url, { headers: { Authorization: `Bearer ${this.gapi.auth.getToken().access_token}` } });

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const content = new Uint8Array(arrayBuffer);

			// Create new stats with actual content size
			const stats = new Stats({ mode: S_IFREG | 0o666, size: content.length });

			// Update stats cache with actual size
			this.statsCache.set(path, stats);

			return new PreloadFile(this, path, flag, stats, content);
		} catch (error) {
			throw convertError(error as DriveError, path, 'openFile');
		}
	}

	public async createFile(path: string, flag: string, mode: number): Promise<File> {
		try {
			const response = await this.gapi.client.drive.files.create({
				resource: {
					name: path.split('/').pop(),
					mimeType: 'application/octet-stream',
				},
				// @ts-expect-error 2353
				media: {
					body: new Uint8Array(0),
					mimeType: 'application/octet-stream',
				},
				fields: 'id',
			});

			this.pathCache.set(path, response.result.id!);
			const stats = new Stats({
				mode: mode | S_IFREG,
				size: 0,
			});
			this.statsCache.set(path, stats);
			this.clearCaches(dirname(path));

			return new PreloadFile(this, path, flag, stats, new Uint8Array(0));
		} catch (error) {
			throw convertError(error as DriveError, path, 'createFile');
		}
	}

	public async unlink(path: string): Promise<void> {
		try {
			const fileId = await this.getFileId(path);
			await this.gapi.client.drive.files.delete({ fileId });
			this.clearCaches(path);
		} catch (error) {
			throw convertError(error as DriveError, path, 'unlink');
		}
	}

	public async mkdir(path: string): Promise<void> {
		try {
			const fileName = this.getNameFromPath(path);
			const response = await this.gapi.client.drive.files.create({
				resource: { name: fileName, mimeType: 'application/vnd.google-apps.folder' },
				fields: 'id',
			});

			this.pathCache.set(path, response.result.id!);
			this.statsCache.set(path, new Stats({ mode: 0o777 | S_IFDIR }));
			this.clearCaches(dirname(path));
		} catch (error) {
			throw convertError(error as DriveError, path, 'mkdir');
		}
	}

	public async rmdir(path: string): Promise<void> {
		try {
			const fileId = await this.getFileId(path);
			await this.gapi.client.drive.files.delete({ fileId });
			this.clearCaches(path);
		} catch (error) {
			throw convertError(error as DriveError, path, 'rmdir');
		}
	}

	public async readdir(path: string): Promise<string[]> {
		path = this.normalizePath(path);
		const cachedDir = this.dirCache.get(path);
		if (cachedDir) return cachedDir;

		try {
			const parentId = await this.getFileId(path);
			const response = await this.gapi.client.drive.files.list({
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
			throw convertError(error as DriveError, path, 'readdir');
		}
	}

	public async sync(path: string, data: Uint8Array): Promise<void> {
		try {
			const fileId = await this.getFileId(path);

			await this.gapi.client.drive.files.update({
				fileId,
				resource: {
					name: path.split('/').pop(),
					mimeType: 'application/octet-stream',
				},
				// @ts-expect-error 2353
				media: {
					mimeType: 'application/octet-stream',
					body: data,
				},
			});

			this.clearCaches(path);
		} catch (error) {
			throw convertError(error as DriveError, path, 'sync');
		}
	}

	public link(target: string): Promise<void> {
		throw ErrnoError.With('ENOTSUP', target, 'link');
	}
}

export interface GoogleDriveOptions {
	gapi: GapiClient;
}

export const GoogleDrive = {
	name: 'GoogleDrive',

	options: {
		gapi: {
			type: 'object',
			required: true,
			description: 'Google API client instance',
		},
	},

	isAvailable(): boolean {
		return true;
	},

	create(options: GoogleDriveOptions) {
		return new GoogleDriveFS(options.gapi);
	},
} satisfies Backend<GoogleDriveFS, GoogleDriveOptions>;
