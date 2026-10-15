import { RepositoryGate } from './components/SharedRepository';
import { Route, Routes } from 'react-router';
import { Shell } from './components/Shell';
import { OverviewPage } from './pages/Overview';
import { ProjectPage } from './pages/Project';
import { LibraryPage } from './pages/Library';
import { MatrixPage } from './pages/Matrix';
import { DoctorPage } from './pages/Doctor';
import { GlobalPage } from './pages/Global';
import { NotFoundPage } from './pages/NotFound';

export function App() {
  return (
    <RepositoryGate><Shell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/matrix" element={<MatrixPage />} />
        <Route path="/doctor" element={<DoctorPage />} />
        <Route path="/global" element={<GlobalPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell></RepositoryGate>
  );
}
