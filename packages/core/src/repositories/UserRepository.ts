import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { NewUser, User } from '../domain/entities';
import { BaseRepository } from './BaseRepository';

@Service()
export class UserRepository extends BaseRepository<User, NewUser> {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';
}
