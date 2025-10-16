import { Home } from 'lucide-react';
import React from 'react';
import { useParams } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';

interface AccountBreadcrumbProps {
  accountId?: string;
}

export function AccountBreadcrumb({ accountId }: AccountBreadcrumbProps) {
  const params = useParams<{ id: string }>();
  const id = accountId || params.id;

  const { data: account, isLoading } = trpc.accounts.getById.useQuery(
    { id: id! },
    { enabled: !!id }
  );

  const breadcrumbs = [
    { name: 'Dashboard', href: '/', isHome: true },
    { name: 'Accounts', href: '/accounts', isHome: false },
    {
      name: isLoading ? null : account?.name || 'Unknown Account',
      href: `/accounts/${id}`,
      isHome: false,
      isLoading,
    },
  ];

  return (
    <Breadcrumb className="hidden md:flex min-w-0 flex-1">
      <BreadcrumbList className="flex-wrap">
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb.href}-${index}`}>
            <BreadcrumbItem className="max-w-[200px]">
              {index === breadcrumbs.length - 1 ? (
                crumb.isLoading ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <BreadcrumbPage className="truncate">{crumb.name}</BreadcrumbPage>
                )
              ) : (
                <BreadcrumbLink to={crumb.href} className="truncate block">
                  {crumb.isHome ? <Home className="h-3.5 w-3.5" /> : crumb.name}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {index < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

interface InstitutionBreadcrumbProps {
  institutionId?: string;
}

export function InstitutionBreadcrumb({ institutionId }: InstitutionBreadcrumbProps) {
  const params = useParams<{ id: string }>();
  const id = institutionId || params.id;

  const { data: institution, isLoading } = trpc.institutions.getById.useQuery(
    { id: id! },
    { enabled: !!id }
  );

  const breadcrumbs = [
    { name: 'Dashboard', href: '/', isHome: true },
    { name: 'Institutions', href: '/institutions', isHome: false },
    {
      name: isLoading ? null : institution?.name || 'Unknown Institution',
      href: `/institutions/${id}`,
      isHome: false,
      isLoading,
    },
  ];

  return (
    <Breadcrumb className="hidden md:flex min-w-0 flex-1">
      <BreadcrumbList className="flex-wrap">
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={`${crumb.href}-${index}`}>
            <BreadcrumbItem className="max-w-[200px]">
              {index === breadcrumbs.length - 1 ? (
                crumb.isLoading ? (
                  <Skeleton className="h-4 w-32" />
                ) : (
                  <BreadcrumbPage className="truncate">{crumb.name}</BreadcrumbPage>
                )
              ) : (
                <BreadcrumbLink to={crumb.href} className="truncate block">
                  {crumb.isHome ? <Home className="h-3.5 w-3.5" /> : crumb.name}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {index < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
