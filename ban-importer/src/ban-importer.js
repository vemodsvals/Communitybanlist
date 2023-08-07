import async from 'async';

import { Ban, BanList, SteamUser } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import BanFetcher from './ban-fetcher.js';

export default class BanImporter {
  constructor(options) {
    options = {
      workers: 2,
      ...options
    };

    this.queueBan = this.queueBan.bind(this);

    this.saveBan = this.saveBan.bind(this);
    this.saveBanQueue = async.queue(this.saveBan, options.workers);

    this.importedBanListIDs = new Set();
    this.importedBanIDs = [];
  }

  async queueBan(importedBans) {
    Logger.verbose('BanImporter', 2, `Queueing batch of ${importedBans.length} raw bans...`);
    if (importedBans.length === 0) return;
    try {
      await SteamUser.bulkCreate(
        importedBans.map((importedBan) => ({ id: importedBan.steamUser })),
        { updateOnDuplicate: ['id'] }
      );

      for (const importedBan of importedBans) {
        this.importedBanListIDs.add(importedBan.banList.id);
        this.importedBanIDs.push(importedBan.id);
        this.saveBanQueue.push(importedBan);
      }
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        1,
        `Failed to queue batch of ${importedBans.length} raw bans: `,
        err
      );
    }
  }

  async saveBan(importedBan) {
    let expiresDate = null;
    try {
      expiresDate = new Date(Date.parse(importedBan.expires));
      if(expiresDate.getFullYear() > 9999) {
        expiresDate = "NULL"
      } else {
        expiresDate = expiresDate.toISOString().slice(0, 19).replace('T', ' ');
      }
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        1,
        `Failed to convert date for (ID: ${importedBan.id}) in ban list (ID: ${importedBan.banList.id}): `,
        err
      );
    }

    try{
      // Create or find the ban.
      const [ban, created] = await Ban.findOrCreate({
        where: {
          id: importedBan.id
        },
        defaults: {
          id: importedBan.id,
          created: importedBan.created || Date.now(),
          expires: expiresDate,
          expired: importedBan.expired,
          reason: importedBan.reason,
          rawReason: importedBan.rawReason,
          rawNote: importedBan.rawNote,
          steamUser: importedBan.steamUser,
          banList: importedBan.banList.id
        }
      });

      // Queue the Steam user for an update if the ban is new or the ban expired status has changed.
      if (created || ban.expired !== importedBan.expired) {
        Logger.verbose(
          'BanImporter',
          2,
          `Found new or updated ban (ID: ${importedBan.id}) in ban list (ID: ${importedBan.banList.id}).`
        );
        await SteamUser.update(
          {
            lastRefreshedExport: null,
            lastRefreshedReputationPoints: null,
            lastRefreshedReputationRank: null
          },
          {
            where: { id: importedBan.steamUser }
          }
        );
      }

      // If it's created there's no need to update the information.
      if (created) return;

      // Update the information.
      ban.expires = importedBan.expires;
      ban.expired = importedBan.expired;
      ban.reason = importedBan.reason;
      ban.rawReason = importedBan.rawReason;
      ban.rawNote = importedBan.rawNote;
      // Save the updated information.
      await ban.save();
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        1,
        `Failed to save raw ban (ID: ${importedBan.id}) in ban list (ID: ${importedBan.banList.id}): `,
        err
      );
    }
  }

  async importBans() {
    const profileStartTime = Date.now();
    Logger.verbose('BanImporter', 2, 'Fetching ban lists to import...');
    const banLists = await BanList.findAll();
    Logger.verbose('BanImporter', 2, `Fetched ${banLists.length} ban lists to import.`);

    const fetcher = new BanFetcher(this.queueBan);

    Logger.verbose('BanImporter', 2, 'Fetching ban lists...');
    const myProgressBar = await Logger.discordProgressBar(
      'BanImporter',
      `Fetching ${banLists.length} Ban Lists...`,
      null,
      0,
      banLists.length,
      0
    );

    let currentList = 0;
    for (const banList of banLists) {
      try {
        await fetcher.fetchBanList(banList);
      } catch (err) {
        Logger.verbose('BanImporter', 1, `Failed to import ban list ${banList.id}: `, err);
      }
      currentList++;
      Logger.discordProgressBar(
        'BanImporter',
        `Fetching ${banLists.length} Ban Lists...`,
        myProgressBar,
        0,
        banLists.length,
        currentList
      );
    }

    Logger.verbose('BanImporter', 2, 'Waiting for bans to be saved...');
    await this.saveBanQueue.drain(() => {
      console.log(`Finished Drain after ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`);
    });

    Logger.verbose('BanImporter', 2, 'Getting deleted bans...');
    const deletedBans = await Ban.findAll({
      attributes: ['steamUser'],
      where: {
        id: { [Op.notIn]: this.importedBanIDs },
        banList: { [Op.in]: [...this.importedBanListIDs] }
      }
    });
    Logger.verbose('BanImporter', 1, `Got ${deletedBans.length} deleted bans`);

    Logger.verbose('BanImporter', 2, 'Queuing Steams for update from deleted bans...');
    await SteamUser.update(
      {
        lastRefreshedInfo: null,
        lastRefreshedExport: null,
        lastRefreshedReputationPoints: null,
        lastRefreshedReputationRank: null
      },
      {
        where: {
          id: {
            [Op.in]: deletedBans.map((deletedBan) => deletedBan.steamUser)
          }
        }
      }
    );

    Logger.verbose('BanImporter', 2, 'Deleting deleted bans...');
    await Ban.destroy({
      where: {
        id: { [Op.notIn]: this.importedBanIDs },
        banList: { [Op.in]: [...this.importedBanListIDs] }
      }
    });
  }
}
