import { createClient, RedisClientType } from 'redis';
import fetch from 'node-fetch';
import retry from 'async-retry';
import { NFTStorage } from 'nft.storage';
import { CID } from 'nft.storage/src/lib/interface';

// NOTE: RipDB = Redis IPFS JSON database
// TODO - replace nft.storage with a different ipfs client

export type RipDBClientOptions = {
  redisUrl: string;
  redisUsername?: string;
  redisPassword?: string;
  ipfsApiKey: string;
  ipfsGatewayBaseUrl?: string;
};

export type Wrapper = {
  cid: CID | 'pending';
  setAtTimestamp?: number;
  authAddress?: string[];
  encrypted?: boolean;
};

export type RipWrapped<T> = Wrapper & {
  data: T | null;
};

export class RipDBClient {
  private redisClient: RedisClientType;
  private ipfsClient: NFTStorage;
  private gatewayUrl: string;

  constructor({
    redisUrl,
    redisUsername,
    redisPassword,
    ipfsApiKey,
    ipfsGatewayBaseUrl,
  }: RipDBClientOptions) {
    this.redisClient = createClient({
      url: redisUrl,
      username: redisUsername,
      password: redisPassword,
    });
    this.ipfsClient = new NFTStorage({ token: ipfsApiKey });
    this.gatewayUrl = ipfsGatewayBaseUrl || 'https://ipfs.io/ipfs';
  }

  private wrapData<T>(dataToWrap: T, config: Wrapper): RipWrapped<T> {
    return {
      ...config,
      setAtTimestamp: Date.now(),
      data: dataToWrap,
    };
  }

  private async _backUpDataToIPFSAsync<T>(
    key: string,
    value: T,
    timeStamp = 0
  ) {
    const dataStr = JSON.stringify(value);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const cid = await this.ipfsClient.storeBlob(blob);

    // If the setAtTimestamps differ then The data has been
    // updated since the backup started--skip setting the CID
    const curr = await this.get<T>(key);
    if (!curr || curr.setAtTimestamp !== timeStamp) {
      return;
    }

    // include the ipfs backup CID in the redis payload
    const backedUpData = {
      ...curr,
      cid,
    };

    await this.redisClient.set(key, JSON.stringify(backedUpData));
  }

  // fetch from IPFS with exponential backoff
  private async fetchJsonFromIPFS<T>(
    cid: CID | 'pending',
    retries = 5
  ): Promise<T> {
    if (cid === 'pending') {
      throw new Error('Cannot fetch from IPFS, backup is pending');
    }

    return await retry(
      async (bail) => {
        // if anything throws, we retry
        const res = await fetch(`${this.gatewayUrl}/${cid}`);

        if (403 === res.status) {
          bail(new Error('Unauthorized'));
          return;
        }

        const data = await res.json();
        return data as T;
      },
      {
        retries,
        factor: 2, // exponential
        maxTimeout: 5 * 60 * 1000, // 5 minutes
      }
    );
  }

  public async set<T>(key: string, value: T): Promise<RipWrapped<T>> {
    const wrapped = this.wrapData(value, { cid: 'pending' });
    await this.redisClient.set(key, JSON.stringify(wrapped));

    // asyncronously upload the data to decentralized storage in the background
    this._backUpDataToIPFSAsync(key, value, wrapped.setAtTimestamp);

    return wrapped;
  }

  public async get<T>(key: string): Promise<RipWrapped<T> | null> {
    const redisVal = await this.redisClient.get(key);
    if (!redisVal) {
      return null;
    }

    const wrapped = JSON.parse(redisVal) as RipWrapped<T>;
    if (wrapped.data) {
      return wrapped;
    }

    // data not available in the cache, fetch backup from IPFS
    const cid = wrapped.cid;
    const json = await this.fetchJsonFromIPFS<T>(cid);
    const nextWrapped = {
      ...wrapped,
      data: json,
    };

    // update the cache to include the fetched data (asyncrounously)
    this.redisClient.set(key, JSON.stringify(nextWrapped));

    return nextWrapped;
  }

  // purge is an explicit function to reclaim some redis space
  // in favor of the IPFS back up. Use this when data is no longer
  // "hot" and fast refresh
  public async purge(key: string) {
    const wrappedStr = await this.redisClient.get(key);
    if (!wrappedStr) {
      return;
    }

    const wrapped = JSON.parse(wrappedStr) as RipWrapped<any>;

    if (wrapped.cid === 'pending') {
      throw new Error('Cannot purge redis before IPFS backup is complete');
    }

    const nextWrapped = {
      ...wrapped,
      data: null,
    };

    await this.redisClient.set(key, JSON.stringify(nextWrapped));
  }
}