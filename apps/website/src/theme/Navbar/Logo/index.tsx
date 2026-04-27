import React from 'react';
import Logo from '@theme-original/Navbar/Logo';
import type LogoType from '@theme/Navbar/Logo';
import type {WrapperProps} from '@docusaurus/types';
import CustomLogo from '@site/src/components/Logo';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';

type Props = WrapperProps<typeof LogoType>;

export default function LogoWrapper(props: Props): React.ReactElement {
  return (
    <Link to={useBaseUrl('/')} className="navbar__brand" style={{textDecoration: 'none'}}>
      <CustomLogo />
    </Link>
  );
}
