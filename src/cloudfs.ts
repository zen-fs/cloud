import type { CreationOptions, InodeLike } from '@zenfs/core';
import { Async, ErrnoError, FileSystem, Inode } from '@zenfs/core';
import { dirname } from '@zenfs/core/path.js';
import { S_IFDIR, S_IFREG } from '@zenfs/core/vfs/constants.js';
import { extendBuffer } from 'utilium/buffer.js';

interface CacheEntry {
	time: number;
	data: Uint8Array;
}

export interface CloudFSOptions {
	/**
	 * How long (in seconds) before a fetched file should be considered invalid
	 * @default 3600 // 1 hour
	 */
	cacheTTL?: number;
}

/**
 * A generic FS for cloud services. Implements caching and error handling
 */
export abstract class CloudFS<TError> extends Async(FileSystem) {
	public constructor(
		id: number,
		name: string,
		public readonly cacheTTL: number = 3600,
		protected convertError: (error: TError, path: string, syscall: string, message?: string) => ErrnoError
	) {
		super(id, name);
	}

	private _convertAndThrow(path: string, syscall: string) {
		return (error: TError | ErrnoError) => {
			throw error instanceof ErrnoError ? error : this.convertError(error, path, syscall);
		};
	}

	protected abstract _move(from: string, to: string): Promise<void>;

	public async rename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath == newPath) return;
		await this._move(oldPath, newPath).catch(this._convertAndThrow(oldPath, 'rename'));
	}

	protected abstract _stat(path: string): Promise<InodeLike>;

	public async stat(path: string): Promise<InodeLike> {
		if (path === '/') return new Inode({ mode: S_IFDIR | 0o755 });

		return await this._stat(path).catch(this._convertAndThrow(path, 'stat'));
	}

	protected abstract _create(path: string, inode: Inode): Promise<void>;

	public async createFile(path: string, options: CreationOptions): Promise<Inode> {
		const inode = new Inode({ mode: options.mode | S_IFREG });

		await this._create(path, inode).catch(this._convertAndThrow(path, 'createFile'));
		return inode;
	}

	protected abstract _delete(path: string, isDirectory: boolean): Promise<void>;

	public async unlink(path: string): Promise<void> {
		const inode = await this.stat(path).catch(this._convertAndThrow(path, 'unlink'));
		if (inode.mode & S_IFDIR) throw ErrnoError.With('EISDIR', path, 'unlink');
		await this._delete(path, false).catch(this._convertAndThrow(path, 'unlink'));
	}

	public async rmdir(path: string): Promise<void> {
		const paths = await this.readdir(path).catch(this._convertAndThrow(path, 'rmdir'));
		if (paths.length > 0) throw ErrnoError.With('ENOTEMPTY', path, 'rmdir');
		await this._delete(path, true).catch(this._convertAndThrow(path, 'rmdir'));
	}

	public async mkdir(path: string, options: CreationOptions): Promise<Inode> {
		// Dropbox's folder creations is recursive, so we check to make sure the parent exists
		const parent = dirname(path);
		const parentInode = await this.stat(parent).catch(this._convertAndThrow(path, 'mkdir'));
		if (parentInode && !(parentInode.mode & S_IFDIR)) throw ErrnoError.With('ENOTDIR', parent, 'mkdir');

		await this._create(path, new Inode({ mode: options.mode | S_IFDIR })).catch(
			this._convertAndThrow(path, 'mkdir')
		);
		return new Inode({ mode: options.mode | S_IFDIR });
	}

	protected _touch?(path: string, inode: Partial<InodeLike>): Promise<void>;

	public async touch(path: string, metadata: Partial<InodeLike> = {}): Promise<void> {
		await this._touch?.(path, metadata).catch(this._convertAndThrow(path, 'touch'));
	}

	public async sync(): Promise<void> {}

	public link(target: string): Promise<void> {
		throw ErrnoError.With('ENOTSUP', target, 'link');
	}

	protected abstract _read(path: string, syscall: string): Promise<Uint8Array>;

	public async read(path: string, buffer: Uint8Array, offset: number, end: number): Promise<void> {
		const data = await this.getValidContents(path, 'read');
		buffer.set(data.subarray(offset, end));
	}

	protected abstract _write(path: string, buffer: Uint8Array, syscall: string): Promise<void>;

	public async write(path: string, data: Uint8Array, offset: number = 0): Promise<void> {
		const buffer = extendBuffer(await this.getValidContents(path, 'write'), offset + data.byteLength);
		buffer.set(data, offset);
		await this._write(path, buffer, 'write').catch(this._convertAndThrow(path, 'write'));
	}

	protected partialCache = new Map<string, CacheEntry>();

	protected async getValidContents(path: string, syscall: string): Promise<Uint8Array> {
		const cache = this.partialCache.get(path);

		if (cache && (cache.time ?? 0 >= performance.now() / 1000 - this.cacheTTL)) return cache.data;

		const data = await this._read(path, syscall).catch(this._convertAndThrow(path, syscall));

		this.partialCache.set(path, { data, time: performance.now() / 1000 });
		return data;
	}
}
