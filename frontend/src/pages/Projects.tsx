import { useParams } from 'react-router-dom'
import { ProjectList } from '../components/projects/ProjectList'
import { ProjectPage } from '../components/projects/ProjectPage'

// One route module for the list and the page, so both share a lazy chunk. The
// tab and the desktop pane live in search params, never the path: the shell's
// error boundary is keyed on pathname, and a path change would remount the page
// and drop the terminal.
export default function Projects() {
  const { projectId } = useParams()
  return projectId ? <ProjectPage key={projectId} projectId={projectId} /> : <ProjectList />
}
