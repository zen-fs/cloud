import type { Backend } from '@zenfs/core';
import { Errno, ErrnoError, Inode } from '@zenfs/core';
import { S_IFDIR, S_IFLNK, S_IFREG } from '@zenfs/core/emulation/constants.js';
import type * as DB from 'dropbox';
import { CloudFS, type CloudFSOptions } from './cloudfs.js';

/**
 * Dropbox paths do not begin with a /,
 * they just begin with a folder at the root node.
 * @param path An absolute path
 */
function fixPath(path: string): string {
	return path == '/' ? '' : path;
}

/**
 * Errors that can be converted
 */
type ConvertableError =
	| DB.files.LookupError
	| DB.files.WriteError
	| DB.files.ListFolderError
	| DB.files.DeleteError
	| DB.files.UploadError
	| DB.files.GetMetadataError
	| DB.files.RelocationError;

type DBError = ConvertableError | DB.Error<ConvertableError>;
type DBReject = DBError | DB.DropboxResponseError<DBError>;
/**
 * Converts a Dropbox error into an `ErrnoError`.
 *
 * Consider changing the behavior from returning the error to just throwing it.
 */
function convertError(error: DBReject, path: string, syscall: string, message?: string): ErrnoError {
	if ('status' in error) {
		error = error.error;
	}

	if (!('.tag' in error)) {
		return convertError(
			error.error,
			path,
			syscall,
			error.user_message?.text || error.error_summary || error.error.toString()
		);
	}
	switch (error['.tag']) {
		case 'path':
			return convertError('path' in error ? error.path : error.reason, path, syscall, message);
		case 'path_lookup':
			return convertError(error.path_lookup, path, syscall, message);
		case 'path_write':
			return convertError(error.path_write, path, syscall, message);
		case 'malformed_path':
		case 'disallowed_name':
		case 'cant_move_folder_into_itself':
		case 'duplicated_or_nested_paths':
			return new ErrnoError(Errno.EBADF, message, path, syscall);
		case 'not_found':
			return ErrnoError.With('ENOENT', path, syscall);
		case 'not_file':
			return ErrnoError.With('EISDIR', path, syscall);
		case 'not_folder':
			return ErrnoError.With('ENOTDIR', path, syscall);
		case 'restricted_content':
		case 'conflict':
		case 'no_write_permission':
		case 'team_folder':
		case 'cant_copy_shared_folder':
		case 'cant_nest_shared_folder':
			return ErrnoError.With('EPERM', path, syscall);
		case 'insufficient_space':
		case 'insufficient_quota':
		case 'too_many_files':
			return new ErrnoError(Errno.ENOSPC, message, path, syscall);
		case 'too_many_write_operations':
			return ErrnoError.With('EAGAIN', path, syscall);
		case 'locked':
			return ErrnoError.With('EBUSY', path, syscall);
		case 'content_hash_mismatch':
			return ErrnoError.With('EBADMSG', path, syscall);
		case 'unsupported_content_type':
			return ErrnoError.With('ENOMSG', path, syscall);
		case 'payload_too_large':
			return ErrnoError.With('EMSGSIZE', path, syscall);
		case 'from_lookup':
			return convertError(error.from_lookup, path, syscall, message);
		case 'from_write':
			return convertError(error.from_write, path, syscall, message);
		case 'to':
			return convertError(error.to, path, syscall, message);
		case 'cant_transfer_ownership':
		case 'internal_error':
		case 'cant_move_shared_folder':
		case 'cant_move_into_vault':
		case 'cant_move_into_family':
		case 'operation_suppressed':
		case 'template_error':
		case 'properties_error':
		case 'other':
			return new ErrnoError(Errno.EIO, message, path, syscall);
		default:
			return new ErrnoError(Errno.EINVAL, 'Unknown error tag: ' + error['.tag'], path, syscall);
	}
}

export class DropboxFS extends CloudFS<DBReject> {
	public constructor(
		public readonly client: DB.Dropbox,
		cacheTTL?: number
	) {
		super(0x64726f70, 'nfs-dropbox', cacheTTL, convertError);
	}

	public async _move(from: string, to: string): Promise<void> {
		await this.client.filesMoveV2({ from_path: fixPath(from), to_path: fixPath(to) });
	}

	public async _stat(path: string): Promise<Inode> {
		const { result } = await this.client.filesGetMetadata({ path: fixPath(path) });

		switch (result['.tag']) {
			case 'file':
				return new Inode({
					mode: (result.symlink_info ? S_IFLNK : S_IFREG) | 0o777,
					size: result.symlink_info?.target?.length || result.size,
					atimeMs: Date.now(),
					mtimeMs: Date.parse(result.server_modified),
				});
			case 'folder':
				return new Inode({ mode: S_IFDIR });
			case 'deleted':
				throw ErrnoError.With('ENOENT', path, 'stat');
			default:
				throw new ErrnoError(Errno.EINVAL, 'Invalid file type', path, 'stat');
		}
	}

	protected async _create(path: string, inode: Inode): Promise<void> {
		if (inode.mode & S_IFDIR) {
			await this.client.filesCreateFolderV2({ path: fixPath(path) });
		} else {
			await this.client.filesUpload({
				contents: new Blob([new Uint8Array()], { type: 'octet/stream' }),
				path: fixPath(path),
			});
		}
	}

	protected async _delete(path: string): Promise<void> {
		await this.client.filesDeleteV2({ path: fixPath(path) });
	}

	public async readdir(path: string): Promise<string[]> {
		const names = ({ entries }: DB.files.ListFolderResult) => {
			return entries.map(e => e.path_display).filter((p): p is string => !!p);
		};

		let { result } = await this.client.filesListFolder({ path: fixPath(path) });

		const entries = names(result);

		// To prevent an infinite loop
		let i = 0;

		while (result.has_more && i < 100) {
			if (++i >= 100) {
				throw new ErrnoError(Errno.EIO, 'Infinite loop prevented', path, 'readdir');
			}

			const response = await this.client.filesListFolderContinue({ cursor: result.cursor });

			result = response.result;
			entries.push(...names(result));
		}

		return entries;
	}

	protected async _read(path: string): Promise<Uint8Array> {
		const { result } = await this.client.filesDownload({ path: fixPath(path) });

		const { fileBinary } = result as DB.files.FileMetadata & { fileBinary: Uint8Array };
		return fileBinary;
	}

	protected async _write(path: string, buffer: Uint8Array): Promise<void> {
		await this.client.filesUpload({
			contents: new Blob([buffer], { type: 'octet/stream' }),
			path: fixPath(path),
			mode: { '.tag': 'overwrite' },
		});
	}
}

export interface DropboxOptions extends CloudFSOptions {
	/**
	 * A v2 Dropbox client
	 */
	client: DB.Dropbox;
}

export const _Dropbox = {
	name: 'Dropbox',

	options: {
		client: { type: 'object', required: true },
		cacheTTL: { type: 'number', required: false },
	},

	isAvailable(): boolean {
		return 'Dropbox' in globalThis;
	},

	create(options) {
		return new DropboxFS(options.client, options.cacheTTL);
	},
} satisfies Backend<DropboxFS, DropboxOptions>;
type _Dropbox = typeof _Dropbox;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Dropbox extends _Dropbox {}
export const Dropbox: Dropbox = _Dropbox;
