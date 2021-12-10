const Moralis = require('moralis/node');
const _ = require('lodash');
const log = require('../utils/logger')(module);
const { getABIData } = require('../utils/helpers');
const { minterAbi } = require('../integrations/ethers/contracts');
const { addMetadata, addPin } = require('../integrations/ipfsService')();
const { logAgendaActionStart } = require('../utils/agenda_action_logger');

const lockLifetime = 1000 * 60 * 5;

module.exports = (context) => {
  context.agenda.define('sync tokens', { lockLifetime }, async (task, done) => {
    try {
      logAgendaActionStart({agendaDefinition: 'sync tokens'});
      const { network, name } = task.attrs.data;
      const tokensForSave = [];
      const offersForUpdate = [];
      const productsForUpdate = [];
      const block_number = [];
      const networkData = context.config.blockchain.networks[network];
      const { serverUrl, appId } = context.config.blockchain.moralis[networkData.testnet ? 'testnet' : 'mainnet'];
      const { abi, topic } = getABIData(minterAbi, 'event', 'TokenMinted');
      const version = await context.db.Versioning.findOne({ name: 'sync tokens', network });

      const options = {
        address: networkData.minterAddress,
        chain: networkData.network,
        topic,
        abi,
        from_block: _.get(version, ['number'], 0)
      };

      // Initialize moralis instances
      Moralis.start({ serverUrl, appId });

      const events = await Moralis.Web3API.native.getContractEvents(options);

      await Promise.all(_.map(events.result, async tokenData => {
        const {
          ownerAddress,
          contractAddress,
          catalogIndex,
          rangeIndex,
          tokenIndex,
        } = tokenData.data;

        block_number.push(Number(tokenData.block_number));

        const contract = contractAddress.toLowerCase();
        const OfferP = Number(catalogIndex);
        const network = networkData.network;

        const [product] = await context.db.OfferPool.aggregate([
          { $match: { contract, marketplaceCatalogIndex: OfferP } },
          {
            $lookup: {
              from: 'Product',
              let: {
                contr: '$contract',
                prod: '$product'
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        {
                          $eq: [
                            '$contract',
                            '$$contr'
                          ]
                        },
                        {
                          $eq: [
                            '$collectionIndexInContract',
                            '$$prod'
                          ]
                        }
                      ]
                    }
                  }
                }
              ],
              as: 'products'
            }
          },
          { $unwind: '$products' },
          { $replaceRoot: { newRoot: '$products' } },
        ]);

        if (!_.isUndefined(product) && !_.isEmpty(product)) {
          const uniqueIndexInContract = product.firstTokenIndex + Number(tokenIndex);
          const authenticityLink = `${ context.config.blockchain.networks[network].authenticityHost }/${ contract }/?a=${ uniqueIndexInContract }`;

          const foundOffers = await context.db.Offer.find({
            contract: contractAddress,
            product: product.collectionIndexInContract
          });

          // increasing number of minted tokens for a particular offer
          if (!_.isEmpty(foundOffers)) {
            const offer = _.find(foundOffers, offer => _.inRange(tokenIndex, offer.range[0], (offer.range[1] + 1)));
            const offerIndex = _.findIndex(offersForUpdate, o => o.contract === offer.contract && o.offerPool === offer.offerPool && o.offerIndex === offer.offerIndex);
            const productIndex = _.findIndex(productsForUpdate, p => p.contract === product.contract && p.collectionIndexInContract === product.collectionIndexInContract);

            if (offerIndex < 0) {
              offer.soldCopies = 1;
              offersForUpdate.push(_.pick(offer, ['contract', 'offerPool', 'offerIndex', 'soldCopies', 'copies', 'sold']));
            } else {
              ++offersForUpdate[offerIndex].soldCopies;
            }

            // increasing number of minted tokens for a particular product
            if (productIndex < 0) {
              product.soldCopies = 1;
              productsForUpdate.push(_.pick(product, ['collectionIndexInContract', 'contract', 'copies', 'soldCopies', 'sold']));
            } else {
              ++productsForUpdate[productIndex].soldCopies;
            }

            const foundToken = await context.db.MintedToken.findOne({
              contract: contractAddress,
              offerPool: catalogIndex,
              token: tokenIndex
            });

            const update = {
              ownerAddress,
              offer: rangeIndex,
              uniqueIndexInContract,
              authenticityLink,
              isMinted: true
            }

            if (!_.isEmpty(foundToken) && !_.isEmpty(foundToken.metadata) && foundToken.metadata.name !== 'none' && foundToken.metadataURI === 'none') {
              const CID = await addMetadata(foundToken.metadata, foundToken.metadata.name);
              await addPin(CID, `metadata_${ foundToken.metadata.name }`);
              update.metadataURI = `${ process.env.PINATA_GATEWAY }/${ CID }`;
            }

            tokensForSave.push({
              updateOne: {
                filter: { contract: contractAddress, offerPool: catalogIndex, token: tokenIndex },
                update,
                upsert: true,
                setDefaultsOnInsert: true
              }
            });
          }
        }
      }));


      if (!_.isEmpty(tokensForSave)) {
        try {
          await context.db.MintedToken.bulkWrite(tokensForSave, { ordered: false });
        } catch (e) {}
      }

      if (!_.isEmpty(offersForUpdate)) {
        try {
          const resultOffers = _.map(offersForUpdate, offer => ({
            updateOne: {
              filter: { contract: offer.contract, offerPool: offer.offerPool, offerIndex: offer.offerIndex },
              update: {
                soldCopies: offer.soldCopies,
                sold: offer.copies === offer.soldCopies
              }
            }
          }));

          await context.db.Offer.bulkWrite(resultOffers, { ordered: false });
        } catch (e) {}
      }

      if (!_.isEmpty(productsForUpdate)) {
        try {
          const resultProducts = _.map(productsForUpdate, prod => ({
            updateOne: {
              filter: { contract: prod.contract, collectionIndexInContract: prod.collectionIndexInContract },
              update: {
                soldCopies: prod.soldCopies,
                sold: prod.copies === prod.soldCopies
              }
            }
          }));

          await context.db.Product.bulkWrite(resultProducts, { ordered: false });
        } catch (e) {}
      }

      if (!_.isEmpty(block_number)) {
        await context.db.Versioning.updateOne({
          name: 'sync tokens',
          network
        }, { number: _.chain(block_number).sortBy().last().value() }, { upsert: true });
      }

      return done();
    } catch (e) {
      log.error(e);
      return done(e);
    }
  });
};
