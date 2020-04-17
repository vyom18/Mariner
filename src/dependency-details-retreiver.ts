import moment from 'moment';
import { RequestQueue, RequesteQueueEntry } from './request-queue';
import { OwnerDataCollection } from './owner-data-collection';
import { sleep } from './utils';
import { DataFetcher, RequestParams } from './data-fetcher';
import { TabDepthLogger } from './tab-level-logger';
import { FetchHttpClient, IHttpClient } from './http';

const REQUEST_DELAY_MS = 1400;
const RELEVANT_LABELS = ['good+first+issue', 'help+wanted', 'documentation'];
const MIN_ISSUE_DATE = moment().subtract(365, 'days')
.format('YYYY-MM-DD');

export class DependencyDetailsRetriever {
    public async run(abbreviated: boolean, githubToken: string): Promise<number> {
        const requestQueue = new RequestQueue();
        const ownerDataCollection = new OwnerDataCollection(abbreviated);
        this.populateRequestQueue(requestQueue, ownerDataCollection, githubToken);
        let nextRequest: RequesteQueueEntry | undefined = requestQueue.popRequest();
        while (nextRequest) {
            await nextRequest.dataFetcher.process(
                nextRequest.requestParams,
                ownerDataCollection,
                requestQueue
            );
            nextRequest = requestQueue.popRequest();
            await sleep(REQUEST_DELAY_MS);
        }

        return Promise.resolve(0);
    }

    private populateRequestQueue(
        requestQueue: RequestQueue,
        ownerDataCollection: OwnerDataCollection,
        githubToken: string
    ): void {
        const httpClient = new FetchHttpClient(githubToken);
        const restfulOwnersDataFetcher = new RestfulOwnersDataFetcher(httpClient);
        const restfulDependenciesDataFetcher = new RestfulDependenciesDataFetcher(httpClient);
        const restfulLanguageAndIssuesDataFetcher = new RestfulLanguageAndIssuesDataFetcher(
            httpClient
        );
        const restfulLabelDataFetcher = new RestfulLabelDataFetcher(httpClient);
        for (const owner of ownerDataCollection.getSortedOwners()) {
            const ownerDataRequestParams: RequestParams = {
                owner,
                type: 'funding',
            };
            requestQueue.queueRequest(ownerDataRequestParams, restfulOwnersDataFetcher);
            // *************** */

            // iterate dependencies
            // *************** */
            for (const dependency of ownerDataCollection.getRepos(owner)) {
                // CREATE contents args
                const dependenciesDataRequestParams = {
                    owner,
                    repo: dependency,
                    type: 'funding',
                };
                // *************** */

                // CONTENTS
                requestQueue.queueRequest(
                    dependenciesDataRequestParams,
                    restfulDependenciesDataFetcher
                );

                // LANGUAGE AND OPEN ISSUES
                const languageAndOpenIssuesCountRequestParams = {
                    owner,
                    repo: dependency,
                    type: 'repo',
                };
                requestQueue.queueRequest(
                    languageAndOpenIssuesCountRequestParams,
                    restfulLanguageAndIssuesDataFetcher
                );

                // LABELS
                RELEVANT_LABELS.forEach((label) => {
                    // CREATE labels args
                    const labelDataRequestParams = {
                        owner,
                        repo: dependency,
                        type: 'issues',
                        label,
                    };
                    requestQueue.queueRequest(labelDataRequestParams, restfulLabelDataFetcher);
                });
            }
        }
    }
}

abstract class BaseRestfulGithubDataFetcher<T> extends DataFetcher<T> {
    protected httpClient: IHttpClient;

    constructor(httpClient: IHttpClient) {
        super();
        this.httpClient = httpClient;
    }

    protected handleError(err: Error): void {
        if (err) {
            TabDepthLogger.error(0, err);
        }
    }

    protected getURL(params: RequestParams, type = 'api'): string {
        let subdomain = '';
        let subdirectory = '';
        if (type === 'api') {
            subdomain = 'api';
            subdirectory = 'repos';
        }

        return `https://${subdomain}.github.com/${subdirectory}/${params.owner}/${params.repo}`;
    }

    // TODO: Factor out other commonalities between the three RESTful fetchers here.
}

class RestfulOwnersDataFetcher extends BaseRestfulGithubDataFetcher<string> {
    public executeRequest(params: RequestParams): Promise<string> {
        const requestUrl = 'https://api.github.com/repos/' + params.owner + '/.github/contents/';

        return this.httpClient
            .get(requestUrl)
            .then((responseText) => {
                const responseJson = JSON.parse(responseText);
                if (responseJson instanceof Object) {
                    const err = new Error(responseJson.message);
                    this.handleError(err);

                    return;
                } else if (responseJson instanceof Array) {
                    for (const file of responseJson) {
                        if (file.name.toLowerCase() === 'funding.yml') {
                            const fundingUrl = file.html_url;

                            return fundingUrl;
                        }
                    }
                }
            })
            .catch((err) => this.handleError(err));
    }

    public updateOwnerDataCollection(
        params: RequestParams,
        fundingUrl: string,
        ownerDataCollection: OwnerDataCollection
    ): void {
        ownerDataCollection.updateOwnerData(params.owner, (ownerData) => {
            ownerData.funding_url = fundingUrl;

            return ownerData;
        });
    }
}

class RestfulDependenciesDataFetcher extends BaseRestfulGithubDataFetcher<undefined> {
    public executeRequest(params: RequestParams): Promise<undefined> {
        const requestUrl = this.getURL(params) + '/contents/.github/';
        // TODO: find out why we do nothing with the result here.
        return this.httpClient.get(requestUrl).then((_) => undefined);
    }

    public updateOwnerDataCollection(
        params: RequestParams,
        _: undefined,
        ownerDataCollection: OwnerDataCollection
    ): void {
        ownerDataCollection.updateRepoData(params.owner, params.repo as string, (__) => {
            const libraryUrl = this.getURL(params);

            return {
                html_url: this.getURL(params, undefined),
                count: ownerDataCollection.getDependentCountForLibrary(libraryUrl),
                issues: {},
            };
        });
    }
}

type LanguageAndOpenIssuesCount = { language: string; openIssuesCount: number; archived: boolean };

class RestfulLanguageAndIssuesDataFetcher extends BaseRestfulGithubDataFetcher<
    LanguageAndOpenIssuesCount
> {
    public executeRequest(params: RequestParams): Promise<LanguageAndOpenIssuesCount> {
        const requestUrl = this.getURL(params);
        TabDepthLogger.info(2, `Querying: ${requestUrl}`);

        return this.httpClient
            .get(requestUrl)
            .then((responseText) => {
                const responseJson = JSON.parse(responseText);

                return {
                    language: responseJson.language as string,
                    openIssuesCount: responseJson.open_issues_count as number,
                    archived: responseJson.archived as boolean,
                };
            })
            .catch((err) => {
                this.handleError(err);
                throw err;
            });
    }

    public updateOwnerDataCollection(
        params: RequestParams,
        languageAndOpenIssuesCount: LanguageAndOpenIssuesCount,
        ownerDataCollection: OwnerDataCollection
    ): void {
        ownerDataCollection.updateRepoData(params.owner, params.repo as string, (repoData) => {
            repoData.language = languageAndOpenIssuesCount.language;
            repoData.open_issues_count = languageAndOpenIssuesCount.openIssuesCount;

            return repoData;
        });
    }

    public updateRequestQueue(
        params: RequestParams,
        languageAndOpenIssuesCount: LanguageAndOpenIssuesCount,
        requestQueue: RequestQueue
    ): void {
        if (
            languageAndOpenIssuesCount.openIssuesCount === 0 ||
            languageAndOpenIssuesCount.archived === true
        ) {
            TabDepthLogger.info(4, 'No Open Issues or Repo Is Archived. Skipping!');
            if (languageAndOpenIssuesCount.archived === true) {
                TabDepthLogger.info(3, `repoIsArchived "${params.owner}/${params.repo}"`);
            }
            RELEVANT_LABELS.forEach((label) => {
                const labelDataRequestParams = {
                    owner: params.owner,
                    repo: params.repo,
                    type: 'issues',
                    label,
                };
                requestQueue.dequeueRequest(labelDataRequestParams);
            });
        }
    }
}

class RestfulLabelDataFetcher extends BaseRestfulGithubDataFetcher<object[]> {
    public executeRequest(params: RequestParams): Promise<object[]> {
        const requestUrl = `${this.getURL(params)}/issues?since=${MIN_ISSUE_DATE}&labels=${
            params.label
        }`;
        TabDepthLogger.info(2, `Querying: ${requestUrl}`);

        return this.httpClient
            .get(requestUrl)
            .then((responseText) => {
                const listOfIssues = JSON.parse(responseText);

                return listOfIssues;
            })
            .catch((err) => this.handleError(err));
    }

    public updateOwnerDataCollection(
        params: RequestParams,
        // tslint:disable-next-line: no-any
        listOfIssues: any[],
        ownerDataCollection: OwnerDataCollection
    ): void {
        if (listOfIssues.length > 0) {
            TabDepthLogger.info(5, 'Found Issues!');
            listOfIssues.forEach((issue) => {
                // If the issue is actually a pull request, skip it and move on.
                if (issue.hasOwnProperty('pull_request') === true) {
                    return;
                }

                ownerDataCollection.updateIssueData(
                    params.owner,
                    params.repo as string,
                    issue.html_url as string,
                    (issueData) => {
                        if (!issueData) {
                            return {
                                title: issue.title,
                                url: issue.html_url,
                                created_at: issue.created_at,
                                tagged: [(params.label as string).replace(/\+/g, ' ')],
                            };
                        } else {
                            issueData.tagged.push((params.label as string).replace(/\+/g, ' '));

                            return issueData;
                        }
                    }
                );
            });
        }
    }
}
