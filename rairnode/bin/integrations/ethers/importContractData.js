const Moralis = require('moralis/node');
const fetch = require('node-fetch');
const log = require('../../utils/logger')(module);

// Contract ABIs
// The RAIR721 contract is still an ERC721 compliant contract,
// so as long as standard functions are called,
// we can connect other NFTs contracts with this ABI

const insertTokens = async (tokens, contract, dbModels) => {
  let validCounter = 0;
  for await (const token of tokens) {
    let metadata;
    if (token.metadata === null && token.token_uri) {
      try {
        log.info(`${token.token_id} has no metadata in Moralis, will try to fetch metadata from ${token.token_uri}`);
        metadata = await (await fetch(token.token_uri)).json();
        // console.log('Fetched data', metadata);
      } catch (err) {
        log.error('Cannot fetch metadata URI!');
        console.log(token.metadata);
        continue;
      }
    } else {
      try {
        // console.log('Metadata', token.metadata);
        metadata = JSON.parse(token.metadata);
      } catch (err) {
        log.error('Cannot parse metadata!');
        console.log(token.metadata);
        continue;
      }
    }
    if (metadata && metadata.image && metadata.name && token.owner_of) {
      // Handle images from IPFS (Use the moralis default gateway)
      metadata.image = metadata.image.replace('ipfs://', 'https://gateway.moralisipfs.com/ipfs/');
      if (!metadata.description) {
        metadata.description = 'No description available';
      }
      if (typeof metadata?.attributes?.at(0) === 'string') {
        metadata.attributes = metadata.attributes.map((item) => ({
          trait_type: '',
          value: item,
        }));
      }
      try {
        await (new dbModels.MintedToken({
          ownerAddress: token.owner_of.toLowerCase(),
          metadataURI: token.token_uri,
          metadata,
          contract: contract._id,
          token: token.token_id,
          uniqueIndexInContract: token.token_id,
          isMinted: true,
          offer: 0,
          offerPool: 0,
          product: 0,
        })).save();
        validCounter += 1;
      } catch (error) {
        log.error(`Error inserting token ${token.token_id}, ${error.name}`);
      }
    }
  }
  return validCounter;
};

const wasteTime = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

module.exports = {
  importContractData: async (networkId, contractAddress, limit, userData, dbModels) => {
    if (!userData.adminRights) {
      log.error("User doesn't have admin rights");
      return {
        success: false,
        result: undefined,
        message: 'Admin rights are required to import!',
      };
    }
    let contract;
    try {
      Moralis.start({
        serverUrl: process.env.MORALIS_SERVER_TEST,
        appId: process.env.MORALIS_API_KEY_TEST,
      });

      contract = await dbModels.Contract.findOne({
        contractAddress,
        blockchain: networkId,
        external: true,
      });

      if (contract) {
        return { success: false, result: undefined, message: 'NFTs already imported' };
      }

      const options = {
        chain: networkId,
        address: contractAddress,
      };
      let allNFTs;
      try {
        allNFTs = await Moralis.Web3API.token.getNFTOwners(options);
      } catch (err) {
        log.error(err);
        return {
          success: false,
          result: undefined,
          message: 'There was an error calling the Moralis API',
        };
      }

      if (allNFTs.total === 0) {
        return {
          success: false,
          result: undefined,
          message: "Couldn't find ERC721 tokens!",
        };
      }

      log.info(`Found ${allNFTs.total}, with ${allNFTs.page_size} tokens on every page`);
      const timesNeeded = Math.round(allNFTs.total / allNFTs.page_size);
      log.info(`Need to do this ${timesNeeded} more times`);

      contract = await (new dbModels.Contract({
        user: 'UNKNOWN - External Import',
        title: allNFTs.result[0].name,
        contractAddress,
        blockchain: networkId,
        diamond: false,
        external: true,
      }));

      const product = await (new dbModels.Product({
        name: allNFTs.result[0].name,
        collectionIndexInContract: 0,
        contract: contract._id,
        copies: allNFTs.total,
        soldCopies: allNFTs.total,
        sold: true,
        firstTokenIndex: 0,
        transactionHash: 'UNKNOWN - External Import',
      }));

      const offer = await new dbModels.Offer({
        offerIndex: 0,
        contract: contract._id,
        product: 0,
        offerPool: 0,
        copies: allNFTs.total,
        soldCopies: allNFTs.total - 1,
        sold: true,
        price: '0',
        range: [0, allNFTs.total],
        offerName: allNFTs.result[0].name,
        transactionHash: 'UNKNOWN - External Import',
      });

      const offerPool = await (new dbModels.OfferPool({
        marketplaceCatalogIndex: 0,
        contract: contract._id,
        product: 0,
        rangeNumber: 0,
        transactionHash: 'UNKNOWN - External Import',
      }));

      let numberOfTokensAdded = await insertTokens(allNFTs.result, contract, dbModels);

      let escapeCounter = 0;
      while (allNFTs?.next) {
        await wasteTime(10000);
        try {
          allNFTs = await allNFTs.next();
        } catch (err) {
          // If next() fails it will retry another 5 times before aborting the process
          log.error(`An error has occured calling page ${allNFTs?.page} of ${timesNeeded}! Will retry...`);
          log.error(err);
          // This avoids the case where it's stuck in a loop of failed requests
          if (escapeCounter < 5) {
            escapeCounter += 1;
            // Since the update of allNFTs failed, allNFTs is still
            // on the same page as before, continuing will retry the call to get the next page
            continue;
          } else {
            throw Error(`Aborted import of contract ${contractAddress}, request for page ${allNFTs.page} failed too many times`);
          }
        }
        // Resets the counter for the next page
        escapeCounter = 0;
        numberOfTokensAdded += await insertTokens(allNFTs.result, contract, dbModels);
        log.info(`Inserted page ${allNFTs?.page} of ${timesNeeded} for ${networkId}/${contractAddress} (${numberOfTokensAdded} NFTs so far)`);
        if (limit > 0 && numberOfTokensAdded > limit) {
          break;
        }
      }

      if (numberOfTokensAdded === 0) {
        return {
          success: false,
          result: undefined,
          message: `Of the ${allNFTs.total} tokens inserted, none of them had metadata!`,
        };
      }

      await contract.save();
      await product.save();
      await offer.save();
      await offerPool.save();

      return {
        success: true,
        result: {
          contract,
          numberOfTokensAdded,
        },
        message: '',
      };
    } catch (err) {
      log.error(err);
      if (contract) {
        dbModels.MintedToken.deleteMany({ contract: contract._id });
        dbModels.Offer.deleteMany({ contract: contract._id });
        dbModels.Product.deleteMany({ contract: contract._id });
      }
      return {
        success: false,
        message: 'An error has ocurred!',
      };
    }
  },
};
