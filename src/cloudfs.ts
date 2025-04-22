import type { CreationOptions, InodeLike } from '@zenfs/core';
import { Async, FileSystem, Inode } from '@zenfs/core';
import { dirname } from '@zenfs/core/path.js';
import { S_IFDIR, S_IFREG } from '@zenfs/core/vfs/constants.js';
import { Exception, withErrno } from 'kerium';
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
		protected convertError: (error: TError, message?: string) => Exception
	) {
		super(id, name);
	}

	private _convertAndThrow = (error: TError | Exception): never => {
		const ex = error instanceof Exception ? error : this.convertError(error);
		Error.captureStackTrace?.(ex, this._convertAndThrow);
		throw ex;
	};

	protected abstract _move(from: string, to: string): Promise<void>;

	public async rename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath == newPath) return;
		await this._move(oldPath, newPath).catch(this._convertAndThrow);
	}

	protected abstract _stat(path: string): Promise<InodeLike>;

	public async stat(path: string): Promise<InodeLike> {
		if (path === '/') return new Inode({ mode: S_IFDIR | 0o755 });

		return await this._stat(path).catch(this._convertAndThrow);
	}

	protected abstract _create(path: string, inode: Inode): Promise<void>;

	public async createFile(path: string, options: CreationOptions): Promise<Inode> {
		const inode = new Inode({ mode: options.mode | S_IFREG });

		await this._create(path, inode).catch(this._convertAndThrow);
		return inode;
	}

	protected abstract _delete(path: string, isDirectory: boolean): Promise<void>;

	public async unlink(path: string): Promise<void> {
		const inode = await this.stat(path).catch(this._convertAndThrow);
		if (inode.mode & S_IFDIR) throw withErrno('EISDIR');
		await this._delete(path, false).catch(this._convertAndThrow);
	}

	public async rmdir(path: string): Promise<void> {
		const paths = await this.readdir(path).catch(this._convertAndThrow);
		if (paths.length > 0) throw withErrno('ENOTEMPTY');
		await this._delete(path, true).catch(this._convertAndThrow);
	}

	public async mkdir(path: string, options: CreationOptions): Promise<Inode> {
		// Dropbox's folder creations is recursive, so we check to make sure the parent exists
		const parent = dirname(path);
		const parentInode = await this.stat(parent).catch(this._convertAndThrow);
		if (parentInode && !(parentInode.mode & S_IFDIR)) throw withErrno('ENOTDIR');

		await this._create(path, new Inode({ mode: options.mode | S_IFDIR })).catch(this._convertAndThrow);
		return new Inode({ mode: options.mode | S_IFDIR });
	}

	protected _touch?(path: string, inode: Partial<InodeLike>): Promise<void>;

	public async touch(path: string, metadata: Partial<InodeLike> = {}): Promise<void> {
		await this._touch?.(path, metadata).catch(this._convertAndThrow);
	}

	public async sync(): Promise<void> {}

	public link(): Promise<void> {
		throw withErrno('ENOTSUP');
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
		await this._write(path, buffer, 'write').catch(this._convertAndThrow);
	}

	protected partialCache = new Map<string, CacheEntry>();

	protected async getValidContents(path: string, syscall: string): Promise<Uint8Array> {
		const cache = this.partialCache.get(path);

		if (cache && (cache.time ?? 0 >= performance.now() / 1000 - this.cacheTTL)) return cache.data;

		const data = await this._read(path, syscall).catch(this._convertAndThrow);

		this.partialCache.set(path, { data, time: performance.now() / 1000 });
		return data;
	}
}
