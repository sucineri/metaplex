#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import fetch from 'node-fetch';

import {
  chunks,
  fromUTF8Array,
  parseDate,
  parsePrice,
  shuffle,
} from './helpers/various';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  CACHE_PATH,
  CONFIG_ARRAY_START,
  CONFIG_LINE_SIZE,
  EXTENSION_JSON,
  EXTENSION_PNG,
  CANDY_MACHINE_PROGRAM_ID,
} from './helpers/constants';
import {
  getBalance,
  getCandyMachineAddress,
  getProgramAccounts,
  loadCandyProgram,
  loadWalletKey,
  AccountAndPubkey,
  createConfig,
} from './helpers/accounts';
import { Config } from './types';
import { upload } from './commands/upload';
import { verifyTokenMetadata } from './commands/verifyTokenMetadata';
import { generateConfigurations } from './commands/generateConfigurations';
import { loadCache, saveCache } from './helpers/cache';
import { mint } from './commands/mint';
import { signMetadata } from './commands/sign';
import {
  getAccountsByCreatorAddress,
  signAllMetadataFromCandyMachine,
} from './commands/signAll';
import log from 'loglevel';
import { createMetadataFiles } from './helpers/metadata';
import { createGenerativeArt } from './commands/createArt';
import { withdraw } from './commands/withdraw';
import { updateFromCache } from './commands/updateFromCache';
import { BN } from '@project-serum/anchor';
program.version('0.0.2');

if (!fs.existsSync(CACHE_PATH)) {
    fs.mkdirSync(CACHE_PATH);
}

console.log(fs.readdirSync(CACHE_PATH));

programCommand('test')
    .action(async (directory, cmd) => {
        console.log("yes");
    });

programCommand('create_candy_machine_configs')
  .argument(
    '<file>',
    'Json file containing metadata',
    path => {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    },
  )
  .action(async (manifest, options, cmd) => {
    const { keypair, cacheName, env, rpcUrl, mutable, retainAuthority } = cmd.opts();
    const cacheContent = loadCache(cacheName, env) || {};
    if (cacheContent.program) {
      throw new Error("a program existed previously. clear it our first if you intent to create a new candy machine");
    }

    const items = cacheContent.items;
    const keys = Object.keys(items);
    if (!items || keys.length === 0) {
      throw new Error("no items in cacheContent");
    }
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    try {
      const res = await createConfig(anchorProgram, walletKeyPair, {
        maxNumberOfLines: new BN(keys.length),
        symbol: manifest.symbol,
        sellerFeeBasisPoints: manifest.seller_fee_basis_points,
        isMutable: mutable,
        maxSupply: new BN(0),
        retainAuthority: retainAuthority,
        creators: manifest.properties.creators.map(creator => {
          return {
            address: new PublicKey(creator.address),
            verified: true,
            share: creator.share,
          };
        }),
      });
  
      console.log(
        `initialized config for a candy machine with publickey: ${res.config.toBase58()}`,
      );
      cacheContent.program = {};
      cacheContent.program.uuid = res.uuid;
      cacheContent.program.config = res.config.toBase58();
      cacheContent.authority = walletKeyPair.publicKey.toBase58();
      saveCache(cacheName, env, cacheContent);
    } catch (err) {
      console.error('Error deploying config to Solana network.', err);
      throw err;
    }

    await addConfigLines(cacheName, env, anchorProgram, walletKeyPair);
});

async function addConfigLines(cacheName: string, env: string, anchorProgram: anchor.Program, walletKeyPair: Keypair) {
  const cacheContent = loadCache(cacheName, env);
  const programConfig = cacheContent.program.config;
  if (!programConfig) {
    throw new Error("missing program config");
  }
  let addConfigSuccessful = true;
  const keys = Object.keys(cacheContent.items);

  try {
    await Promise.all(
      chunks(Array.from(Array(keys.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for(let offset = 0; offset < allIndexesInSlice.length; offset += 10) {
            const indexes = allIndexesInSlice.slice(offset, offset + 10);
            const onChain = indexes.filter(i => {
              return cacheContent.items[keys[i]].onChain || false;
            });

            if (onChain.length != indexes.length) {
              const ind = keys[indexes[0]];
              console.log(`adding config lines ${ind}-${keys[indexes[indexes.length - 1]]}`);
              try {
                const configs = indexes.map(i => ({
                  uri: cacheContent.items[keys[i]].link,
                  name: cacheContent.items[keys[i]].name,
                }));
                
                await anchorProgram.rpc.addConfigLines(
                  ind,
                  configs,
                  {
                    accounts: {
                      config: programConfig,
                      authority: walletKeyPair.publicKey,
                    },
                    signers: [walletKeyPair]
                  }
                );

                indexes.forEach(i => {
                  cacheContent.items[keys[i]].onChain = true;
                });
                saveCache(cacheName, env, cacheContent);
              } catch (err) {
                console.error(`adding config lines ${ind}-${keys[indexes[indexes.length - 1]]} failed`, err);
                addConfigSuccessful = false;
              }
            }
          }
      }));
  } catch (err) {
    console.error(err);
  } finally {
    saveCache(cacheName, env, cacheContent);
  }
  console.log(`Done. Successful = ${addConfigSuccessful}`);
}

function programCommand(name: string) {
    return program
        .command(name)
        .option(
        '-e, --env <string>',
        'Solana cluster env name',
        'devnet', //mainnet-beta, testnet, devnet
        )
        .option(
        '-k, --keypair <path>',
        `Solana wallet location`,
        '--keypair not provided',
        )
        .option('-l, --log-level <string>', 'log level', setLogLevel)
        .option('-c, --cache-name <string>', 'Cache file name', 'temp');
}

function setLogLevel(value, prev) {
    if (value === undefined || value === null) {
      return;
    }
    log.info('setting the log value to: ' + value);
    log.setLevel(value);
}
  
program.parse(process.argv);