import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import configuration from '@/config/entities/__tests__/configuration';
import { RequestScopedLoggingModule } from '@/logging/logging.module';
import { TestLoggingModule } from '@/logging/__tests__/test.logging.module';
import { NetworkModule } from '@/datasources/network/network.module';
import { TestNetworkModule } from '@/datasources/network/__tests__/test.network.module';
import { TestAppProvider } from '@/__tests__/test-app.provider';
import { AccountDataSourceModule } from '@/datasources/account/account.datasource.module';
import { TestAccountDataSourceModule } from '@/datasources/account/__tests__/test.account.datasource.module';
import * as request from 'supertest';
import { IAccountDataSource } from '@/domain/interfaces/account.datasource.interface';
import { EmailControllerModule } from '@/routes/email/email.controller.module';
import { INestApplication } from '@nestjs/common';
import { accountBuilder } from '@/domain/account/entities/__tests__/account.builder';
import { verificationCodeBuilder } from '@/domain/account/entities/__tests__/verification-code.builder';

const resendLockWindowMs = 100;
const ttlMs = 1000;
describe('Email controller resend verification tests', () => {
  let app: INestApplication;
  let accountDataSource: jest.MockedObjectDeep<IAccountDataSource>;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const defaultTestConfiguration = configuration();
    const testConfiguration: typeof configuration = () => ({
      ...defaultTestConfiguration,
      email: {
        ...defaultTestConfiguration['email'],
        verificationCode: {
          resendLockWindowMs: resendLockWindowMs,
          ttlMs: ttlMs,
        },
      },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule.register(testConfiguration), EmailControllerModule],
    })
      .overrideModule(AccountDataSourceModule)
      .useModule(TestAccountDataSourceModule)
      .overrideModule(CacheModule)
      .useModule(TestCacheModule)
      .overrideModule(RequestScopedLoggingModule)
      .useModule(TestLoggingModule)
      .overrideModule(NetworkModule)
      .useModule(TestNetworkModule)
      .compile();

    accountDataSource = moduleFixture.get(IAccountDataSource);

    app = await new TestAppProvider().provide(moduleFixture);
    await app.init();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resends email verification successfully', async () => {
    const account = accountBuilder().with('isVerified', false).build();
    const verificationCode = verificationCodeBuilder()
      .with('generatedOn', new Date())
      .with('sentOn', new Date())
      .build();
    accountDataSource.getAccount.mockResolvedValueOnce(account);
    accountDataSource.getAccountVerificationCode.mockResolvedValue(
      verificationCode,
    );
    accountDataSource.setEmailVerificationSentDate.mockResolvedValueOnce(
      verificationCode,
    );

    // Advance timer by the minimum amount of time required to resend email
    jest.advanceTimersByTime(resendLockWindowMs);
    await request(app.getHttpServer())
      .post(
        `/v1/chains/${account.chainId}/safes/${account.safeAddress}/emails/${account.signer}/verify-resend`,
      )
      .expect(202)
      .expect({});

    expect(accountDataSource.setEmailVerificationCode).toHaveBeenCalledTimes(0);
    expect(accountDataSource.getAccountVerificationCode).toHaveBeenCalledTimes(
      2,
    );
    expect(
      accountDataSource.setEmailVerificationSentDate,
    ).toHaveBeenCalledTimes(1);
  });

  it('triggering email resend within lock window returns 429', async () => {
    const account = accountBuilder().with('isVerified', false).build();
    const verificationCode = verificationCodeBuilder()
      .with('generatedOn', new Date())
      .with('sentOn', new Date())
      .build();
    accountDataSource.getAccount.mockResolvedValue(account);
    accountDataSource.getAccountVerificationCode.mockResolvedValue(
      verificationCode,
    );

    // Advance timer to a time within resendLockWindowMs
    jest.advanceTimersByTime(resendLockWindowMs - 1);
    await request(app.getHttpServer())
      .post(
        `/v1/chains/${account.chainId}/safes/${account.safeAddress}/emails/${account.signer}/verify-resend`,
      )
      .expect(429)
      .expect({
        message: 'Verification cannot be resent at this time',
        statusCode: 429,
      });
  });

  it('triggering email resend on verified emails throws 409', async () => {
    const account = accountBuilder().with('isVerified', true).build();
    accountDataSource.getAccount.mockResolvedValue(account);

    jest.advanceTimersByTime(resendLockWindowMs);
    await request(app.getHttpServer())
      .post(
        `/v1/chains/${account.chainId}/safes/${account.safeAddress}/emails/${account.signer}/verify-resend`,
      )
      .expect(409)
      .expect({
        message: `Cannot verify the provided email for the provided account ${account.signer}`,
        statusCode: 409,
      });
  });

  it('resend email with new code', async () => {
    const account = accountBuilder().with('isVerified', false).build();
    const verificationCode = verificationCodeBuilder()
      .with('generatedOn', new Date())
      .with('sentOn', new Date())
      .build();
    accountDataSource.getAccount.mockResolvedValueOnce(account);
    accountDataSource.getAccountVerificationCode.mockResolvedValueOnce(
      verificationCode,
    );

    // Advance timer so that code is considered as expired
    jest.advanceTimersByTime(ttlMs);
    await request(app.getHttpServer())
      .post(
        `/v1/chains/${account.chainId}/safes/${account.safeAddress}/emails/${account.signer}/verify-resend`,
      )
      .expect(202)
      .expect({});

    // TODO 3rd party mock checking that the new code was sent out (and not the old one)
  });
});
