/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { Event, Uri } from 'vscode';

export interface RepositoryState {
	readonly onDidChange: Event<void>;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly state: RepositoryState;
}

export interface API {
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}
