import type {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';

export type Item = Record<string, unknown>;
export type Key = { pk: string; sk: string };
export type StoreCommand =
  | BatchWriteCommand
  | DeleteCommand
  | GetCommand
  | PutCommand
  | QueryCommand
  | ScanCommand
  | TransactWriteCommand
  | UpdateCommand;
export type DocumentResult = {
  Item?: Item;
  Items?: Item[];
  Attributes?: Item;
  LastEvaluatedKey?: Key;
  UnprocessedItems?: Record<string, { DeleteRequest?: { Key: Key }; PutRequest?: { Item: Item } }[]>;
  $metadata?: unknown;
};
export interface DocumentSender {
  send(command: StoreCommand): Promise<DocumentResult>;
}
export type MailCounter = { key: string; period: number; limit: number; span?: number };
export type Purpose = 'signin' | 'delete';
export type SessionInput = { user_id?: string | null; email?: string | null; now: number; expires: number };

/** Profile DTO: persisted field names remain unchanged; dates are calendar strings. */
export class Subscriber {
  user_id: string;
  email: string;
  birthday: string;
  tz: string;
  send_time: string;
  status: string;
  last_sent_date: string | null;
  pause_from: string | null;
  pause_through: string | null;
  place: Item | null;
  describe: boolean;
  badges: boolean;
  inbox: string | null;
  constructor(item: Item) {
    this.user_id = String(item.pk).replace(/^USER#/, '');
    this.email = String(item.email);
    this.birthday = String(item.birthday);
    this.tz = String(item.tz);
    this.send_time = String(item.send_time ?? '06:00');
    this.status = String(item.status ?? 'active');
    this.last_sent_date = item.last_sent_date == null ? null : String(item.last_sent_date);
    this.pause_from = item.pause_from == null ? null : String(item.pause_from);
    this.pause_through = item.pause_through == null ? null : String(item.pause_through);
    this.place =
      item.lat == null || item.lon == null || !item.tz
        ? null
        : Object.fromEntries(['city', 'region', 'country', 'tz', 'lat', 'lon'].map((k) => [k, item[k] ?? '']));
    this.describe = Boolean(item.describe);
    this.badges = item.badges !== false;
    this.inbox = item.inbox == null ? null : String(item.inbox);
  }
  static fromItem(item: Item) {
    return new Subscriber(item);
  }
  pausedOn(day: string): boolean {
    return Boolean(this.pause_from && this.pause_through && this.pause_from <= day && day <= this.pause_through);
  }
}
