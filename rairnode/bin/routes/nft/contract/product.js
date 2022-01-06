const express = require('express');
const _ = require('lodash');
const { validation } = require('../../../middleware');

module.exports = context => {
  const router = express.Router();

  // Get minted tokens from a product
  router.get('/', validation('getTokensByContractProduct', 'query'), async (req, res, next) => {
    try {
      const { contract, product } = req;
      const { fromToken = 0, toToken = 0, limit = 0 } = req.query;

      const firstToken = Number(fromToken);
      const lastToken = Number(toToken);
      const numberOfTokens = Number(limit);

      const offerPool = await context.db.OfferPool.findOne({ contract: contract._id, product });
      const totalCount = await context.db.MintedToken.countDocuments({
        contract: contract._id,
        offerPool: offerPool.marketplaceCatalogIndex
      });
      const tokens = await context.db.MintedToken.find({
        contract: contract._id,
        offerPool: offerPool.marketplaceCatalogIndex,
        token: !!lastToken ? { $gt: (firstToken - 1), $lt: (lastToken + 1) } : { $gt: (firstToken - 1) }
      })
        .sort([['token', 1]])
        .limit(numberOfTokens);

      return res.json({ success: true, result: { totalCount, tokens } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tokenNumbers', async (req, res, next) => {
    try {
      const { contract, product } = req;
      const offerPool = await context.db.OfferPool.findOne({ contract: contract._id, product });
      const tokens = await context.db.MintedToken.find({
        contract: contract._id,
        offerPool: offerPool.marketplaceCatalogIndex
      })
        .sort([['token', 1]])
        .distinct('token');

      return res.json({ success: true, tokens });
    } catch (err) {
      next(err);
    }
  });

  // Get specific token by internal token ID
  router.get('/token/:token', async (req, res, next) => {
    try {
      const { contract, product } = req;
      const { token } = req.params;
      const sanitizedToken = Number(token);
      const result = await context.db.OfferPool.aggregate([
        { $match: { contract: contract._id, product } },
        {
          $lookup: {
            from: "MintedToken",
            let: {
              contractOP: '$contract',
              offerPoolIndex: '$marketplaceCatalogIndex',
              tokenRequested: sanitizedToken
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      {
                        $eq: [
                          "$contract",
                          "$$contractOP"
                        ]
                      },
                      {
                        $eq: [
                          "$offerPool",
                          "$$offerPoolIndex"
                        ]
                      },
                      {
                        $eq: [
                          "$token",
                          "$$tokenRequested"
                        ]
                      }
                    ]
                  }
                }
              }
            ],
            as: "mintedTokens"
          }
        },
        { $unwind: '$mintedTokens' },
        { $replaceRoot: { newRoot: '$mintedTokens' } },
      ]);

      const re = _.head(result)

      res.json({ success: true, result: re ? re : null });
    } catch (err) {
      next(err);
    }
  });

  // Get list of files locked by token
  router.get('/files/:token', async (req, res, next) => {
    try {
      const { token } = req.params;
      const { contract, product } = req;
      const sanitizedToken = Number(token);
      const offerPoolRaw = await context.db.OfferPool.findOne({ contract: contract._id, product });

      if (_.isEmpty(offerPoolRaw)) {
        res.json({ success: false, message: 'Offer pool which belong to this particular product not found.' });
        return;
      }

      const offerPool = offerPoolRaw.toObject();

      const files = await context.db.MintedToken.aggregate([
        { $match: { contract: contract._id, offerPool: offerPool.marketplaceCatalogIndex, token: sanitizedToken } },
        {
          $lookup: {
            from: 'File',
            let: {
              contractT: '$contract',
              offerIndex: '$offer',
              productT: product
            },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      {
                        $eq: [
                          '$contract',
                          '$$contractT'
                        ]
                      },
                      {
                        $eq: [
                          '$product',
                          '$$productT'
                        ]
                      },
                      {
                        $in: [
                          '$$offerIndex',
                          '$offer'
                        ]
                      }
                    ]
                  }
                }
              }
            ],
            as: 'files'
          },
        },
        { $unwind: '$files' },
        { $replaceRoot: { newRoot: '$files' } },
      ]);

      res.json({ success: true, files });
    } catch (err) {
      next(err);
    }
  });

  // get single product with all related offers
  router.get('/offers', async (req, res, next) => {
    try {
      const { contract, product: collectionIndexInContract } = req;

      const [product] = await context.db.Product.aggregate([
        { $match: { contract: contract._id, collectionIndexInContract } },
        {
          $lookup: {
            from: 'Offer',
            let: {
              contr: '$contract',
              prod: '$collectionIndexInContract'
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
                          '$product',
                          '$$prod'
                        ]
                      }
                    ]
                  }
                }
              }
            ],
            as: 'offers'
          }
        }
      ]);

      if (!product) {
        res.json({ success: false, message: 'Product not found.' });
        return;
      }

      res.json({ success: true, product });
    } catch (err) {
      next(err);
    }
  });

  // get locks for specific product
  router.get('/locks', async (req, res, next) => {
    try {
      const { contract, product } = req;

      const locks = await context.db.LockedTokens.find({ contract: contract._id, product });

      res.json({ success: true, locks });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
