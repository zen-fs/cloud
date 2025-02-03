import type { Backend, InodeLike } from '@zenfs/core';
import { encodeRaw, Errno, ErrnoError, Stats } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/emulation/constants.js';
import { basename, dirname, join } from '@zenfs/core/emulation/path.js';
import { CloudFS, type CloudFSOptions } from './cloudfs.js';

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

export class GoogleDriveFS extends CloudFS<DriveError> {
	private pathCache: Map<string, string> = new Map();
	private statsCache: Map<string, Stats> = new Map();
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
		this.statsCache.delete(path);
		this.dirCache.delete(dirname(path));
	}

	private async getFileId(path: string, syscall: string): Promise<string> {
		const cachedId = this.pathCache.get(path);
		if (cachedId) return cachedId;

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
			const response = await this.drive.files.list({
				q: `name = '${segment}' and '${parentId}' in parents and trashed = false`,
				fields: 'files(id, name, mimeType)',
				spaces: 'drive',
			});

			const { files } = response.result;
			if (!files || files.length === 0) throw ErrnoError.With('ENOENT', path, syscall);

			parentId = fileId;
			fileId = files[0].id!;
			this.pathCache.set(currentPath, fileId);
		}

		return fileId;
	}

	protected async _move(from: string, to: string): Promise<void> {
		const name = basename(to);
		await this.drive.files.update({ fileId: await this.getFileId(from, 'rename'), resource: { name } });
		this.clearCaches(from);
		this.clearCaches(to);
	}

	// Update other methods to use normalizePath
	protected async _stat(path: string): Promise<Stats> {
		const cachedStats = this.statsCache.get(path);
		if (cachedStats) return cachedStats;

		const { result } = await this.drive.files.get({
			fileId: await this.getFileId(path, 'stat'),
			fields: 'mimeType, size, modifiedTime',
		});

		const isDirectory = result.mimeType === 'application/vnd.google-apps.folder';

		const stats = new Stats({
			mode: isDirectory ? S_IFDIR | 0o777 : S_IFREG | 0o666,
			size: parseInt(result.size!),
			mtimeMs: new Date(result.modifiedTime!).getTime(),
			atimeMs: Date.now(),
		});

		this.statsCache.set(path, stats);
		return stats;
	}

	protected async _create(path: string, stats: Stats): Promise<void> {
		const { result } = await this.drive.files.create({
			resource: {
				name: basename(path),
				mimeType: 'application/' + (stats.isDirectory() ? 'vnd.google-apps.folder' : 'octet-stream'),
				// @ts-expect-error 2353
				media: stats.isDirectory()
					? undefined
					: { body: new Uint8Array(0), mimeType: 'application/octet-stream' },
			},
			fields: 'id',
		});

		this.pathCache.set(path, result.id!);
		this.statsCache.set(path, stats);
		this.clearCaches(dirname(path));
	}

	protected async _delete(path: string, isDirectory: boolean): Promise<void> {
		const syscall = isDirectory ? 'rmdir' : 'mkdir';

		try {
			await this.drive.files.delete({ fileId: await this.getFileId(path, syscall) });
			this.clearCaches(path);
		} catch (error) {
			throw convertError(error as DriveError, path, syscall);
		}
	}

	public async readdir(path: string): Promise<string[]> {
		const cachedDir = this.dirCache.get(path);
		if (cachedDir) return cachedDir;

		try {
			const parentId = await this.getFileId(path, 'readdir');
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
			throw convertError(error as DriveError, path, 'readdir');
		}
	}

	protected async _read(path: string, syscall: string): Promise<Uint8Array> {
		const fileId = await this.getFileId(path, syscall);

		// First get the file metadata to check its type
		const metadata = await this.drive.files.get({ fileId, fields: 'mimeType, size' });

		// If it's a Google Doc, we need to export it
		const isGoogleDoc = metadata.result.mimeType?.startsWith('application/vnd.google-apps.');

		const result = isGoogleDoc
			? await this.drive.files.export({ fileId, mimeType: 'text/plain' })
			: await this.drive.files.get({ fileId, alt: 'media' });

		return encodeRaw(result.body);
	}

	protected async _write(path: string, body: Uint8Array, stats: Partial<InodeLike>, syscall: string): Promise<void> {
		await this.drive.files.update({
			fileId: await this.getFileId(path, syscall),
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
