import { EntitySchema } from '@mikro-orm/core';

// Persistence mapping only; balance stays an exact decimal string.
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
});
