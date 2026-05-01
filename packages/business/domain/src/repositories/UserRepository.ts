import { BaseRepository } from '@scani/db';
import type { NewUser, User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Service } from 'typedi';

@Service()
export class UserRepository extends BaseRepository<User, NewUser> {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';
}
