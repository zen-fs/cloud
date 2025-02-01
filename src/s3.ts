import type { S3 } from '@aws-sdk/client-s3';
import type { ResponseMetadata } from '@aws-sdk/types';
import type { Backend, FileSystem, InodeLike } from '@zenfs/core';
import { _inode_fields, Errno, ErrnoError, InMemory, log, normalizePath, Stats } from '@zenfs/core';
import { join } from '@zenfs/core/vfs/path.js';
import { CloudFS, type CloudFSOptions } from './cloudfs.js';

export type Metadata = Partial<Record<keyof InodeLike, string>>;

function stringifyStats(stats: Partial<InodeLike>): Partial<Metadata> {
	const data: Partial<Metadata> = {};
	for (const prop of _inode_fields) {
		if (prop in stats) data[prop] = stats[prop]?.toString();
	}
	return data;
}

function parseStats(metadata: Metadata): Stats {
	const data: Partial<InodeLike> = {};
	for (const prop of _inode_fields) {
		if (prop in metadata) data[prop] = +metadata[prop]!;
	}
	return new Stats(data);
}

/**
 * @internal @hidden
 */
type _S3Error = Error & { name?: string };

function convertError(error: _S3Error, path: string, syscall: string): never {
	throw new ErrnoError(Errno.EREMOTEIO, error.message, path, syscall);
}

function checkStatus(metadata: ResponseMetadata, path: string, syscall: string, ...expected: number[]) {
	if (expected.some(code => code == metadata.httpStatusCode)) return;
}

export class S3FileSystem extends CloudFS<_S3Error> {
	protected prefix: string;

	declare _sync?: FileSystem;

	public constructor(
		protected client: S3,
		protected bucketName: string,
		prefix: string = '',
		cacheTTL?: number
	) {
		super(0x61777333, 'nfs-s3', cacheTTL, convertError);
		this.prefix = normalizePath('/' + prefix + '/').slice(1);
		this._sync = InMemory.create({ name: 's3:' + bucketName });
	}

	public async ready() {
		await super.ready();
		await this.stat('/').catch(async (error: ErrnoError) => {
			if (error.code != 'ENOENT') return;
			await this.mkdir('/', 0o777);
		});
	}

	/**
	 * @todo Handle prefix
	 */
	public async _stat(path: string): Promise<Stats> {
		const { Metadata, ContentLength, LastModified } = await this.client.headObject({
			Bucket: this.bucketName,
			Key: path,
		});

		if (!Metadata) throw ErrnoError.With('ENODATA', path, 'stat');

		const stats = parseStats(Metadata as Metadata);

		if (stats.size != ContentLength) log.warn('Mismatch between stats size and content length: ' + path);
		if (stats.mtime != LastModified) throw ErrnoError.With('EBADMSG', path, 'stat');

		return stats;
	}

	public async readdir(path: string): Promise<string[]> {
		const response = await this.client.listObjectsV2({
			Bucket: this.bucketName,
			Prefix: path == '/' ? this.prefix : path,
			Delimiter: '/',
		});

		// Special handling for root directory
		if (path == '/' && !response.Contents?.length && !response.CommonPrefixes?.length) {
			return [];
		}

		const directories =
			response.CommonPrefixes?.map(prefix => prefix.Prefix!.replace(path, '').replace(/\/$/, '')) || [];
		const files =
			response.Contents?.filter(content => content.Key != path).map(content => content.Key!.replace(path, '')) ||
			[];

		return [...directories, ...files].filter(name => name.length);
	}

	protected async _delete(path: string, isDirectory: boolean): Promise<void> {
		const syscall = isDirectory ? 'rmdir' : 'unlink';
		if (path == '/') throw ErrnoError.With('EPERM', path, syscall);

		const { $metadata: $md } = await this.client.deleteObject({ Bucket: this.bucketName, Key: path });

		checkStatus($md, path, syscall, 204);
	}

	public async _move(from: string, to: string): Promise<void> {
		const { $metadata: $md } = await this.client.copyObject({
			Bucket: this.bucketName,
			CopySource: join(this.bucketName, from),
			Key: to,
		});

		checkStatus($md, to, 'rename', 200);

		await this.unlink(from);
	}

	protected async _create(path: string, stats: Stats): Promise<void> {
		const syscall = stats.isDirectory() ? 'mkdir' : 'createFile';
		// The root directory should always exist
		if (path === '/') throw ErrnoError.With('EEXIST', '/', syscall);

		const { $metadata: $md } = await this.client.putObject({
			Bucket: this.bucketName,
			Key: path,
			Body: new Uint8Array(),
			ContentLength: 0,
			Metadata: stringifyStats(stats),
		});

		checkStatus($md, path, syscall, 200, 201);
	}

	protected async _read(path: string, syscall: string): Promise<Uint8Array> {
		const { $metadata: $md, Body } = await this.client.getObject({ Bucket: this.bucketName, Key: path });

		checkStatus($md, path, syscall, 200);

		const data = await Body?.transformToByteArray();

		if (!data) throw ErrnoError.With('ENODATA', path, 'openFile');

		return data;
	}

	protected async _write(path: string, data: Uint8Array, stats: Partial<InodeLike>, syscall: string): Promise<void> {
		const { $metadata: $md } = await this.client.putObject({
			Bucket: this.bucketName,
			Key: path,
			Body: data,
			ContentLength: data.byteLength,
			ContentType: 'application/octet-stream',
			Metadata: stringifyStats(stats),
		});

		checkStatus($md, path, syscall, 200);
	}
}

export interface S3Options extends CloudFSOptions {
	bucketName: string;
	client: S3;
	prefix?: string;
}

const _S3Bucket = {
	name: 'S3',
	options: {
		bucketName: { type: 'string', required: true, description: 'The name of the bucket you want to use' },
		client: { type: 'object', required: true, description: 'Authenticated S3 client' },
		prefix: { type: 'string', required: false, description: 'The prefix to use for all operations' },
		cacheTTL: { type: 'number', required: false },
	},
	isAvailable(): boolean {
		return true;
	},
	create(opt: S3Options): S3FileSystem {
		return new S3FileSystem(opt.client, opt.bucketName, opt.prefix, opt.cacheTTL);
	},
} as const satisfies Backend<S3FileSystem, S3Options>;
type _S3Bucket = typeof _S3Bucket;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface S3Bucket extends _S3Bucket {}
export const S3Bucket: S3Bucket = _S3Bucket;
