import type { S3 } from '@aws-sdk/client-s3';
import type { Backend, File, StatsLike } from '@zenfs/core';
import { Async, ErrnoError, FileSystem, InMemory, PreloadFile, Stats } from '@zenfs/core';
import { S_IFDIR, S_IFMT } from '@zenfs/core/emulation/constants.js';
import { join } from '@zenfs/core/emulation/path.js';

export type Metadata = Partial<Record<keyof StatsLike, string>>;

const keys = ['size', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'mode', 'ino', 'uid', 'gid'] as const;

function stringifyStats(stats: Partial<StatsLike>): Partial<Metadata> {
	const data: Partial<Metadata> = {};
	for (const prop of keys) {
		if (prop in stats) {
			data[prop] = stats[prop]?.toString();
		}
	}
	return data;
}

function parseStats(metadata: Metadata): Stats {
	const data: Partial<StatsLike> = {};
	for (const prop of keys) {
		if (prop in metadata) {
			data[prop] = +metadata[prop]!;
		}
	}
	return new Stats(data);
}

export class S3FileSystem extends Async(FileSystem) {
	protected prefix: string;

	public constructor(
		protected client: S3,
		protected bucketName: string,
		prefix: string = ''
	) {
		super();
		prefix = prefix.startsWith('/') ? prefix.slice(1) : prefix;
		this.prefix = prefix.endsWith('/') ? prefix : prefix + '/';

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
	public async stat(path: string): Promise<Stats> {
		// Special case for the root path, assume it always exists
		if (path === '/') {
			return new Stats({ mode: S_IFDIR | 0o755 });
		}

		const response = await this.client.headObject({ Bucket: this.bucketName, Key: path }).catch((error: Error & { name?: string }) => {
			if (error.name == 'NotFound') {
				return;
			}
			throw error;
		});

		if (!response) {
			throw ErrnoError.With('ENOENT', path, 'stat');
		}

		const metadata = response.Metadata as Metadata | undefined;

		if (!metadata) {
			throw ErrnoError.With('ENODATA', path, 'stat');
		}

		const stats = parseStats(metadata);

		if (stats.size != response.ContentLength) {
			throw ErrnoError.With('EBADMSG', path, 'stat');
		}

		if (stats.mtime != response.LastModified) {
			throw ErrnoError.With('EBADMSG', path, 'stat');
		}

		return stats;
	}

	public async mkdir(path: string, mode: number): Promise<void> {
		// Skip if trying to create the root directory, as it should always exist
		if (path === '/') {
			return;
		}

		const now = Date.now();

		const response = await this.client.putObject({
			Bucket: this.bucketName,
			Key: path,
			Body: '',
			ContentLength: 0,
			Metadata: stringifyStats({
				mode: (mode & ~S_IFMT) | S_IFDIR,
				ctimeMs: now,
				atimeMs: now,
				mtimeMs: now,
				birthtimeMs: now,
			}),
		});

		if (response.$metadata.httpStatusCode !== 200) {
			throw ErrnoError.With('EIO', path, 'mkdir');
		}
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

		const directories = response.CommonPrefixes?.map(prefix => prefix.Prefix!.replace(path, '').replace(/\/$/, '')) || [];
		const files = response.Contents?.filter(content => content.Key != path).map(content => content.Key!.replace(path, '')) || [];

		return [...directories, ...files].filter(name => name.length);
	}

	public async rmdir(path: string): Promise<void> {
		if (path == '/') {
			throw ErrnoError.With('EPERM', path, 'rmdir');
		}
		const contents = await this.readdir(path);
		if (contents.length > 0) {
			throw ErrnoError.With('ENOTEMPTY', path, 'rmdir');
		}

		await this.client.deleteObject({
			Bucket: this.bucketName,
			Key: path,
		});
	}

	public async unlink(path: string): Promise<void> {
		const response = await this.client.deleteObject({
			Bucket: this.bucketName,
			Key: path,
		});

		if (response.$metadata.httpStatusCode !== 204) {
			throw ErrnoError.With('ENOENT', path, 'unlink');
		}
	}

	public async rename(oldPath: string, newPath: string): Promise<void> {
		const response = await this.client.copyObject({
			Bucket: this.bucketName,
			CopySource: join(this.bucketName, oldPath),
			Key: newPath,
		});
		if (response.$metadata.httpStatusCode !== 200) {
			throw ErrnoError.With('EIO', newPath, 'rename');
		}

		await this.unlink(oldPath);
	}

	public async createFile(path: string, flag: string): Promise<File> {
		const response = await this.client.putObject({
			Bucket: this.bucketName,
			Key: path,
			Body: new Uint8Array(),
		});
		if (response.$metadata.httpStatusCode != 200) {
			throw ErrnoError.With('EIO', path, 'createFile');
		}

		return this.openFile(path, flag);
	}

	public async openFile(path: string, flag: string): Promise<File> {
		const response = await this.client.getObject({
			Bucket: this.bucketName,
			Key: path,
		});
		if (response.$metadata.httpStatusCode != 200) {
			throw ErrnoError.With('ENOENT', path, 'openFile');
		}

		const data = await response.Body?.transformToByteArray();

		if (!data) {
			throw ErrnoError.With('ENODATA', path, 'openFile');
		}

		const stats = await this.stat(path);
		stats.size = data.byteLength;

		return new PreloadFile(this, path, flag, stats, data);
	}

	public link(_target: string, link: string): Promise<void> {
		throw ErrnoError.With('ENOSYS', link, 'link');
	}

	public async sync(path: string, data: Uint8Array, stats: Readonly<Stats>): Promise<void> {
		const response = await this.client.putObject({
			Bucket: this.bucketName,
			Key: path,
			Body: data,
			ContentLength: data.byteLength,
			ContentType: 'application/octet-stream',
			Metadata: stringifyStats(stats),
		});

		if (response.$metadata.httpStatusCode !== 200) {
			throw ErrnoError.With('EIO', path, 'sync');
		}
	}
}

export interface S3Options {
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
	},
	isAvailable(): boolean {
		return true;
	},
	create({ client, bucketName, prefix }: S3Options): S3FileSystem {
		return new S3FileSystem(client, bucketName, prefix);
	},
} as const satisfies Backend<S3FileSystem, S3Options>;
type _S3Bucket = typeof _S3Bucket;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface S3Bucket extends _S3Bucket {}
export const S3Bucket: S3Bucket = _S3Bucket;
