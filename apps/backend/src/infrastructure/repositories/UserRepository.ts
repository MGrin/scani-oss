import { Service } from 'typedi';
import type { NewUser, User } from '../../domain/entities';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class UserRepository extends BaseRepository<User, NewUser> {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';
}
