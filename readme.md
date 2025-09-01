# ZenFS Cloud

This package adds backends for many cloud providers to ZenFS, including:

- Dropbox
- Amazon Web Services' S3
- Google Drive

For more information, see the [API documentation](https://zenfs.dev/cloud).

Please read the [ZenFS core documentation](https://zenfs.dev/core)!

### Installing

> [!IMPORTANT]
> This project is licensed under the LGPL (v3+).

```sh
npm install @zenfs/cloud
```

## Examples

### Dropbox

```ts
import { configure, fs } from '@zenfs/core';
import { Dropbox } from '@zenfs/cloud';
import { Dropbox as DropboxClient } from 'dropbox';

const client = new DropboxClient({
	accessToken: '...',
	// ...
});

await configure({
	mounts: {
		'/mnt/dropbox': {
			backend: Dropbox,
			client,
		},
	},
});
```

### S3

> [!CAUTION]
> This backend is still in the process of being developed and is not stable.

```ts
import { configure, fs } from '@zenfs/core';
import { S3Bucket } from '@zenfs/cloud';
import { S3 } from '@aws-sdk/client-s3';

const client = new S3({
	// ...
});

await configure({
	mounts: {
		'/mnt/s3': {
			backend: S3Bucket,
			bucketName: 'your-bucket',
			client,
		},
	},
});
```
