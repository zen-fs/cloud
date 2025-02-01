import type { File, InodeLike } from '@zenfs/core';
import { Async, ErrnoError, FileSystem, LazyFile, PreloadFile, Stats } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/vfs/constants.js';
import { dirname } from '@zenfs/core/vfs/path.js';
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

	protected abstract _stat(path: string): Promise<Stats>;

	public async stat(path: string): Promise<Stats> {
		if (path === '/') return new Stats({ mode: S_IFDIR | 0o755 });

		return await this._stat(path).catch(this._convertAndThrow(path, 'stat'));
	}

	public async openFile(path: string, flag: string): Promise<File> {
		const stats = await this.stat(path).catch(this._convertAndThrow(path, 'openFile'));
		return new LazyFile(this, path, flag, stats);
	}

	protected abstract _create(path: string, stats: Stats): Promise<void>;

	public async createFile(path: string, flag: string, mode: number): Promise<File> {
		const stats = new Stats({ mode: mode | S_IFREG });

		await this._create(path, stats).catch(this._convertAndThrow(path, 'createFile'));

		return new PreloadFile(this, path, flag, stats, new Uint8Array());
	}

	protected abstract _delete(path: string, isDirectory: boolean): Promise<void>;

	public async unlink(path: string): Promise<void> {
		const stats = await this.stat(path).catch(this._convertAndThrow(path, 'unlink'));
		if (stats.isDirectory()) throw ErrnoError.With('EISDIR', path, 'unlink');
		await this._delete(path, false).catch(this._convertAndThrow(path, 'unlink'));
	}

	public async rmdir(path: string): Promise<void> {
		const paths = await this.readdir(path).catch(this._convertAndThrow(path, 'rmdir'));
		if (paths.length > 0) throw ErrnoError.With('ENOTEMPTY', path, 'rmdir');
		await this._delete(path, true).catch(this._convertAndThrow(path, 'rmdir'));
	}

	public async mkdir(path: string, mode: number): Promise<void> {
		// Dropbox's folder creations is recursive, so we check to make sure the parent exists
		const parent = dirname(path);
		const stats = await this.stat(parent).catch(this._convertAndThrow(path, 'mkdir'));
		if (stats && !stats.isDirectory()) throw ErrnoError.With('ENOTDIR', parent, 'mkdir');

		await this._create(path, new Stats({ mode: mode | S_IFDIR })).catch(this._convertAndThrow(path, 'mkdir'));
	}

	public async sync(path: string, data: Uint8Array, stats: Partial<InodeLike> = {}): Promise<void> {
		await this._write(path, data, stats, 'sync').catch(this._convertAndThrow(path, 'sync'));
	}

	public link(target: string): Promise<void> {
		throw ErrnoError.With('ENOTSUP', target, 'link');
	}

	protected abstract _read(path: string, syscall: string): Promise<Uint8Array>;

	public async read(path: string, buffer: Uint8Array, offset: number, end: number): Promise<void> {
		const data = await this.getValidContents(path, 'read');
		buffer.set(data.subarray(offset, end));
	}

	protected abstract _write(
		path: string,
		buffer: Uint8Array,
		stats: Partial<InodeLike>,
		syscall: string
	): Promise<void>;

	public async write(path: string, data: Uint8Array, offset: number = 0): Promise<void> {
		const buffer = extendBuffer(await this.getValidContents(path, 'write'), offset + data.byteLength);
		buffer.set(data, offset);
		await this._write(path, buffer, {}, 'write').catch(this._convertAndThrow(path, 'write'));
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
