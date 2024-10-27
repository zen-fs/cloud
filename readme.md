# ZenFS Cloud

> [!WARNING]
> This package was implemented very recently and may not be stable.
>
> If you find a bug, please report it. Thanks!

This package adds backends for many cloud providers to ZenFS, including Dropbox, S3, and in the future, Google Drive.

For more information, see the [API documentation](https://zenfs.dev/cloud).

> [!IMPORTANT]
> Please read the [ZenFS core documentation](https://zenfs.dev/core)!

## Installing

```sh
npm install @zenfs/cloud
```

## Usage

> [!NOTE]
> The examples are written in ESM.  
> For CJS, you can `require` the package.  
> If using a browser environment, you can use a `<script>` with `type=module` (you may need to use import maps)

#### Dropbox

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

#### S3

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
